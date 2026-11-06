import CoreImage
import CoreImage.CIFilterBuiltins
import PiHubCore
import SwiftUI

/// The open pairing window: a QR code with the `pi-remote://pair` link and
/// the six-digit code for typing it in under Nearby. Closes itself when a
/// new iPhone appears in the trusted list.
struct PairingPanel: View {
  let model: HubModel

  var body: some View {
    VStack(spacing: 10) {
      if let name = model.justPaired {
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: 44))
          .foregroundStyle(.green)
        Text("Paired “\(name)”").font(.headline)
        Text("It can now open sessions in your shared folders.")
          .font(.caption)
          .foregroundStyle(.secondary)
        Button("Done") { model.closePairing() }
          .keyboardShortcut(.defaultAction)
      } else if let pairing = model.pairing {
        Text("Pair an iPhone").font(.headline)
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let remaining = HubFormatting.countdown(until: pairing.pairingExpiresAt, now: context.date)
          VStack(spacing: 10) {
            if let link = pairing.pairingLink, let image = QRCode.image(for: link), remaining != nil {
              Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .frame(width: 190, height: 190)
                .padding(8)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
            }
            Text("Scan with the iPhone camera, or tap this Mac under Nearby in Pi Remote and enter:")
              .font(.caption)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
            Text(spaced(pairing.pairingCode ?? ""))
              .font(.system(size: 28, weight: .semibold, design: .monospaced))
              .textSelection(.enabled)
              .opacity(remaining == nil ? 0.3 : 1)
            if let remaining {
              Text("Expires in \(remaining)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
            } else {
              Text("This code has expired.").font(.caption).foregroundStyle(.orange)
              Button("New Code") { Task { await model.startPairing() } }
            }
          }
        }
        Button("Cancel") { model.closePairing() }
          .keyboardShortcut(.cancelAction)
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity)
  }

  private func spaced(_ code: String) -> String {
    code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
  }
}

enum QRCode {
  static func image(for text: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
          let cgImage = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return NSImage(cgImage: cgImage, size: NSSize(width: output.extent.width, height: output.extent.height))
  }
}
