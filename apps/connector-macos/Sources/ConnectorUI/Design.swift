import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/// Multiplayer AI, in native form.
///
/// The same design language the room already speaks, said in AppKit's terms: a quiet ground,
/// hairline structure, colour reserved for state, and typography carrying the hierarchy. One
/// serif is held back for identity — the product's name, the workspace, the question being
/// asked — against the system sans for everything operational. Both faces are the platform's,
/// so a window opens at its right size without waiting on anything.
public enum Palette {
    /// One definition per colour, both appearances given at once, so nothing is left to a media
    /// query that might not be there and no colour is defined only for the dark case.
    private static func dynamic(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let values = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: values.0 / 255, green: values.1 / 255, blue: values.2 / 255, alpha: 1)
        })
    }

    public static let paper   = dynamic(light: (247, 248, 246), dark: (23, 26, 23))
    public static let surface = dynamic(light: (255, 255, 255), dark: (32, 36, 33))
    public static let sunken  = dynamic(light: (236, 239, 234), dark: (40, 45, 41))
    public static let ink     = dynamic(light: (23, 26, 23),    dark: (240, 243, 239))
    public static let ink2    = dynamic(light: (63, 72, 66),    dark: (203, 209, 202))
    public static let muted   = dynamic(light: (102, 112, 105), dark: (150, 158, 151))
    public static let faint   = dynamic(light: (138, 147, 140), dark: (118, 126, 119))
    public static let line    = dynamic(light: (223, 227, 222), dark: (57, 63, 58))

    public static let live    = dynamic(light: (63, 115, 91),   dark: (122, 178, 148))
    public static let wait    = dynamic(light: (156, 98, 24),   dark: (206, 156, 84))
    public static let stop    = dynamic(light: (164, 66, 54),   dark: (218, 122, 110))
}

/// The mark. A letter, not an image: it renders at any size, in any appearance, with nothing
/// to load and nothing to go missing.
public struct BrandMark: View {
    private let size: CGFloat
    public init(size: CGFloat = 30) { self.size = size }
    public var body: some View {
        Text("M")
            .font(.system(size: size * 0.56, weight: .medium, design: .serif))
            .foregroundStyle(Palette.paper)
            .frame(width: size, height: size)
            .background(Palette.ink, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
    }
}

/// One screen of the first run. Every one of them is the same shape — mark, a heading that says
/// what this is for, a line of context, and one decision — so moving through setup feels like
/// one continuous act rather than a series of unrelated forms.
public struct Sheet<Content: View, Actions: View>: View {
    private let title: String
    private let lead: String?
    private let content: Content
    private let actions: Actions

    public init(title: String, lead: String? = nil,
                @ViewBuilder content: () -> Content,
                @ViewBuilder actions: () -> Actions) {
        self.title = title; self.lead = lead
        self.content = content(); self.actions = actions()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 14) {
                    BrandMark()
                    VStack(alignment: .leading, spacing: 8) {
                        Text(title)
                            // Tight leading and negative tracking as it grows: large type reads
                            // too loose at the spacing that suits body copy.
                            .font(.system(size: 30, weight: .regular, design: .serif))
                            .tracking(-0.5)
                            .lineSpacing(-1)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        if let lead {
                            Text(lead)
                                .font(.system(size: 14))
                                .lineSpacing(3)
                                .foregroundStyle(Palette.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                content
                actions
            }
            .frame(maxWidth: 460, alignment: .leading)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .padding(.horizontal, 56)
        .padding(.vertical, 44)
        .background(Palette.paper)
    }
}

public struct PrimaryButton: View {
    private let title: String
    private let busy: Bool
    private let action: () -> Void
    @Environment(\.isEnabled) private var enabled

    public init(_ title: String, busy: Bool = false, action: @escaping () -> Void) {
        self.title = title; self.busy = busy; self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(busy ? "\(title)…" : title).font(.system(size: 14, weight: .medium))
                if busy {
                    ProgressView().controlSize(.small).scaleEffect(0.7)
                        .frame(width: 12, height: 12)
                }
            }
            .frame(minWidth: 120)
            .padding(.horizontal, 18).padding(.vertical, 10)
            .foregroundStyle(Palette.paper)
            .background(Palette.ink.opacity(enabled ? 1 : 0.32), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

public struct QuietButton: View {
    private let title: String
    private let action: () -> Void
    public init(_ title: String, action: @escaping () -> Void) { self.title = title; self.action = action }
    public var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 13)).foregroundStyle(Palette.muted)
        }
        .buttonStyle(.plain)
    }
}

/// A labelled field. The label is above rather than beside it, because every screen here asks
/// for one thing and the eye should travel straight down.
public struct Field: View {
    private let label: String
    private let placeholder: String
    private let hint: String?
    @Binding private var value: String
    private let onSubmit: () -> Void

    public init(_ label: String, placeholder: String, hint: String? = nil,
                value: Binding<String>, onSubmit: @escaping () -> Void = {}) {
        self.label = label; self.placeholder = placeholder; self.hint = hint
        self._value = value; self.onSubmit = onSubmit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.6)
                .textCase(.uppercase)
                .foregroundStyle(Palette.faint)
            TextField(placeholder, text: $value)
                .textFieldStyle(.plain)
                .font(.system(size: 15))
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
                .onSubmit(onSubmit)
            if let hint {
                Text(hint).font(.system(size: 12)).foregroundStyle(Palette.faint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// What happened, and what to do now — the two halves every failure in this app owes a person.
public struct Problem: View {
    private let what: String
    private let todo: String
    public init(what: String, todo: String) { self.what = what; self.todo = todo }
    public var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(what).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.stop)
            if !todo.isEmpty {
                Text(todo).font(.system(size: 13)).foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Palette.stop.opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// A small dot that means one thing. Never decorative.
public struct StateDot: View {
    private let tone: Health.Tone
    public init(tone: Health.Tone) { self.tone = tone }
    public var body: some View {
        Circle().fill(color).frame(width: 7, height: 7)
    }
    private var color: Color {
        switch tone {
        case .good: return Palette.live
        case .working: return Palette.wait
        case .stopped: return Palette.stop
        case .idle: return Palette.faint
        }
    }
}
