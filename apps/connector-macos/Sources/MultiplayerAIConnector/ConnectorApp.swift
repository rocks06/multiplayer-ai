import SwiftUI
import ConnectorUI

@main
struct ConnectorApp: App {
    @State private var model = ConnectorModel()

    var body: some Scene {
        MenuBarExtra {
            MenuView(model: model)
                .frame(width: 320)
        } label: {
            // Semantic only: the mark is the product's, the dot is the state.
            Image(nsImage: MenuBarIcon.image(for: model.health))
        }
        .menuBarExtraStyle(.window)
    }
}

