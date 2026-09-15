import AppKit
import PDFKit
import WebKit

/// Raster-only PDF preview: no document scripts, links, forms, file URLs or network requests.
/// Only the workspace's main frame may submit already-authorized bytes.
@MainActor
final class PDFPreviewBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "multiplayerPDF"
    private let origin: URL
    private let renderer = PDFPreviewRenderer()

    init(origin: URL) { self.origin = origin }

    static func install(in configuration: WKWebViewConfiguration, origin: URL) {
        configuration.userContentController.addScriptMessageHandler(
            PDFPreviewBridge(origin: origin), contentWorld: .page, name: name)
    }

    static func permits(mainFrame: Bool, source: URL?, origin: URL) -> Bool {
        mainFrame && source.map { WebSession.isInternal($0, base: origin) } == true
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard Self.permits(mainFrame: message.frameInfo.isMainFrame,
                           source: message.frameInfo.request.url, origin: origin) else {
            replyHandler(nil, "PDF preview is restricted to the workspace main frame."); return
        }
        guard let body = message.body as? [String: Any] else {
            replyHandler(nil, PreviewError.invalid.localizedDescription); return
        }
        Task { @MainActor in
            do { replyHandler(try await handle(body), nil) }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }

    enum PreviewError: LocalizedError {
        case invalid, unreadable, expired
        var errorDescription: String? {
            switch self {
            case .invalid: "Invalid PDF preview request."
            case .unreadable: "This PDF cannot be previewed. It may be damaged or password-protected. Download it to open in a PDF reader."
            case .expired: "This PDF preview has closed. Reopen Preview to try again."
            }
        }
    }

    func handle(_ body: [String: Any]) async throws -> [String: Any] {
        switch body["action"] as? String {
        case "open":
            guard let encoded = body["data"] as? String else { throw PreviewError.invalid }
            let result = try await renderer.open(encoded)
            return ["token": result.token, "pages": result.pages]
        case "page":
            guard let token = body["token"] as? String, let page = body["page"] as? Int else { throw PreviewError.invalid }
            return ["image": try await renderer.page(token: token, index: page)]
        case "close":
            guard let token = body["token"] as? String else { throw PreviewError.invalid }
            await renderer.close(token: token)
            return [:]
        default: throw PreviewError.invalid
        }
    }
}

/// Own PDFKit objects on a serial actor away from the UI thread. Neither parsing a large file
/// nor rasterizing a complex page should block closing the modal or using the rest of the app.
/// Retain only one document per web view; page images have a fixed pixel budget.
private actor PDFPreviewRenderer {
    private static let maxBytes = 50 * 1024 * 1024
    private var document: PDFDocument?
    private var token: String?
    private typealias PreviewError = PDFPreviewBridge.PreviewError

    func open(_ encoded: String) throws -> (token: String, pages: Int) {
        guard encoded.utf8.count <= ((Self.maxBytes + 2) / 3) * 4,
              let bytes = Data(base64Encoded: encoded), bytes.count <= Self.maxBytes,
              bytes.starts(with: Data("%PDF-".utf8)) else { throw PreviewError.invalid }
        guard let pdf = PDFDocument(data: bytes), !pdf.isLocked, pdf.pageCount > 0 else {
            throw PreviewError.unreadable
        }
        document = pdf
        let id = UUID().uuidString
        token = id
        return (id, pdf.pageCount)
    }

    func page(token id: String, index: Int) throws -> String {
        guard id == token, let document else { throw PreviewError.expired }
        guard index >= 0, index < document.pageCount, let page = document.page(at: index) else { throw PreviewError.invalid }
        return try autoreleasepool {
            let image = page.thumbnail(of: NSSize(width: 1440, height: 2048), for: .cropBox)
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]) else { throw PreviewError.unreadable }
            return "data:image/png;base64," + png.base64EncodedString()
        }
    }

    func close(token id: String) {
        if id == token { document = nil; token = nil }
    }
}
