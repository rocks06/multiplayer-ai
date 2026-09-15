import AppKit
import CoreGraphics
import Testing
import WebKit
@testable import ConnectorUI

@Suite(.serialized) @MainActor struct PDFPreviewTests {
    static let origin = URL(string: "http://127.0.0.1:4198")!

    static func fixture() -> Data {
        let data = NSMutableData()
        let consumer = CGDataConsumer(data: data)!
        var box = CGRect(x: 0, y: 0, width: 300, height: 400)
        let context = CGContext(consumer: consumer, mediaBox: &box, nil)!
        for color in [CGColor(red: 1, green: 0, blue: 0, alpha: 1), CGColor(red: 0, green: 0, blue: 1, alpha: 1)] {
            context.beginPDFPage(nil)
            context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(box)
            context.setFillColor(color); context.fill(CGRect(x: 50, y: 50, width: 200, height: 300))
            context.endPDFPage()
        }
        context.closePDF()
        return data as Data
    }

    @Test func rendererRejectsInvalidRequestsAndReleasesDocument() async throws {
        let bridge = PDFPreviewBridge(origin: Self.origin)
        await #expect(throws: (any Error).self) { _ = try await bridge.handle(["action": "open", "data": Data("<script>bad</script>".utf8).base64EncodedString()]) }
        await #expect(throws: (any Error).self) { _ = try await bridge.handle(["action": "open", "data": Data("%PDF-broken".utf8).base64EncodedString()]) }
        let opened = try await bridge.handle(["action": "open", "data": Self.fixture().base64EncodedString()])
        #expect(opened["pages"] as? Int == 2)
        let token = try #require(opened["token"] as? String)
        await #expect(throws: (any Error).self) { _ = try await bridge.handle(["action": "page", "token": token, "page": 2]) }
        await #expect(throws: (any Error).self) { _ = try await bridge.handle(["action": "page", "token": "other", "page": 0]) }
        for index in 0..<2 {
            let result = try await bridge.handle(["action": "page", "token": token, "page": index])
            let encoded = try #require(result["image"] as? String).replacingOccurrences(of: "data:image/png;base64,", with: "")
            let bitmap = try #require(NSBitmapImageRep(data: Data(base64Encoded: encoded)!))
            #expect(bitmap.pixelsWide <= 1440 && bitmap.pixelsHigh <= 2048)
            let color = try #require(bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)?.usingColorSpace(.deviceRGB))
            #expect(index == 0 ? color.redComponent > 0.9 && color.blueComponent < 0.1 : color.blueComponent > 0.9 && color.redComponent < 0.1)
        }
        _ = try await bridge.handle(["action": "close", "token": token])
        await #expect(throws: (any Error).self) { _ = try await bridge.handle(["action": "page", "token": token, "page": 0]) }
    }

    @Test func onlyWorkspaceMainFrameIsAllowed() {
        #expect(PDFPreviewBridge.permits(mainFrame: true, source: Self.origin, origin: Self.origin))
        #expect(!PDFPreviewBridge.permits(mainFrame: false, source: Self.origin, origin: Self.origin))
        for source in [nil, URL(string: "file:///tmp/test.pdf"), URL(string: "https://example.com"), URL(string: "http://127.0.0.1:4199"), URL(string: "blob:http://127.0.0.1:4198/test")] {
            #expect(!PDFPreviewBridge.permits(mainFrame: true, source: source, origin: Self.origin))
        }
    }

    /// This runs the REAL AttachmentCard/PDFPreview React code in the macOS WKWebView,
    /// with no account/connector/runtime. A painted canvas pixel is the assertion, not an iframe.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["PDF_PREVIEW_TEST_URL"] != nil))
    func actualReactPreviewPaintsBothPagesInWKWebView() async throws {
        let origin = URL(string: ProcessInfo.processInfo.environment["PDF_PREVIEW_TEST_URL"]!)!
        _ = NSApplication.shared
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        PDFPreviewBridge.install(in: config, origin: origin)
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 900, height: 750), configuration: config)
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        window.orderFront(nil)
        defer { window.orderOut(nil); view.loadHTMLString("", baseURL: nil) }
        view.load(URLRequest(url: origin))
        try await wait(view, expression: "!!window.pdfFixtureReady")
        let pdf = Self.fixture().base64EncodedString()
        // Diagnostic only: future WebKit versions may support this. Never relax the product sandbox.
        for sandbox in [true, false] {
            _ = try await view.evaluateJavaScript("window.showLegacyPDF('\(pdf)',\(sandbox))")
            try await Task.sleep(for: .seconds(2))
            let snapshot = try await view.takeSnapshot(configuration: nil)
            let bitmap = try #require(NSBitmapImageRep(data: snapshot.tiffRepresentation!))
            var colored = 0
            for y in stride(from: 0, to: bitmap.pixelsHigh, by: 4) {
                for x in stride(from: 0, to: bitmap.pixelsWide, by: 4) {
                    if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
                       color.redComponent > 0.7 && color.blueComponent < 0.4 { colored += 1 }
                }
            }
            print("BASELINE WKWebView sandbox=\(sandbox): red PDF pixel samples=\(colored)")
            if let directory = ProcessInfo.processInfo.environment["PDF_PREVIEW_EVIDENCE_DIR"],
               let png = bitmap.representation(using: .png, properties: [:]) {
                try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("baseline-sandbox-\(sandbox).png"))
            }
            _ = try await view.evaluateJavaScript("window.clearLegacyPDF()")
        }
        _ = try await view.evaluateJavaScript("window.setPDFFixture('\(pdf)')")
        try await wait(view, expression: "!!document.querySelector('.attachment-actions button')")
        _ = try await view.evaluateJavaScript("document.querySelector('.attachment-actions button').click()")
        try await wait(view, expression: "!!document.querySelector('.pdf-page-scroll img')?.complete && document.querySelector('.pdf-page-scroll img').naturalWidth > 0")
        try await assertPixel(view, red: true)
        _ = try await view.evaluateJavaScript("document.querySelector('.pdf-preview nav button:last-child').click()")
        try await wait(view, expression: "document.querySelector('.pdf-page-scroll img')?.alt.endsWith('page 2') && document.querySelector('.pdf-page-scroll img')?.complete && document.querySelector('.pdf-page-scroll img').naturalWidth > 0")
        try await assertPixel(view, red: false)
        let snapshot = try await view.takeSnapshot(configuration: nil)
        if let directory = ProcessInfo.processInfo.environment["PDF_PREVIEW_EVIDENCE_DIR"],
           let tiff = snapshot.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("native-pdf-page-2.png"))
        }
        _ = try await view.evaluateJavaScript("document.querySelector('[aria-label=\"Close preview\"]').click()")
        try await wait(view, expression: "!document.querySelector('dialog')")
        print("NATIVE PDF PASS: actual React AttachmentCard, two distinct PDF pages painted in WKWebView, close releases preview")
    }

    private func wait(_ view: WKWebView, expression: String) async throws {
        for _ in 0..<150 {
            if (try? await view.evaluateJavaScript(expression)) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        let text = try? await view.evaluateJavaScript("document.body.innerText")
        Issue.record("Timed out: \(expression); page: \(String(describing: text))")
        throw PDFPreviewBridge.PreviewError.invalid
    }

    private func assertPixel(_ view: WKWebView, red: Bool) async throws {
        let result = try await view.evaluateJavaScript("""
        (() => {const img=document.querySelector('.pdf-page-scroll img');const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return Array.from(ctx.getImageData(c.width/2,c.height/2,1,1).data)})()
        """)
        let pixel = try #require(result as? [Int])
        #expect(pixel.count == 4)
        #expect(red ? pixel[0] > 220 && pixel[2] < 80 : pixel[2] > 220 && pixel[0] < 80)
        print("WKWebView PDF rendered pixel: \(pixel)")
    }
}
