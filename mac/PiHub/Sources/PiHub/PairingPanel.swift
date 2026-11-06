import CoreImage
import CoreImage.CIFilterBuiltins
import PiHubCore
import SwiftUI

/// The open pairing window: a QR code with the `pi-remote://pair` link and
/// the six-digit code for typing it in under Nearby. Closes itself when a
/// new iPhone appears in the trusted list.
struct PairingPanel: View {
  let model: HubModel

  /// How long a pairing code lives on the hub.
  private static let codeLifetime: TimeInterval = 120

  var body: some View {
    VStack(spacing: 14) {
      if let name = model.justPaired {
        Image(systemName: "checkmark")
          .font(.system(size: 30, weight: .bold))
          .foregroundStyle(.white)
          .frame(width: 64, height: 64)
          .glassEffect(.regular.tint(.green), in: .circle)
          .padding(.top, 6)
        VStack(spacing: 4) {
          Text("Paired “\(name)”").font(.title3.weight(.semibold))
          Text("It can now open sessions in your shared folders.")
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }
        Button("Done") { model.closePairing() }
          .buttonStyle(.glassProminent)
          .controlSize(.large)
          .keyboardShortcut(.defaultAction)
      } else if let pairing = model.pairing {
        Text("Pair an iPhone").font(.title3.weight(.semibold))
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let remaining = HubFormatting.countdown(until: pairing.pairingExpiresAt, now: context.date)
          VStack(spacing: 14) {
            if let link = pairing.pairingLink, let image = QRCode.image(for: link), remaining != nil {
              Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .frame(width: 176, height: 176)
                .padding(12)
                .background(Color.white, in: .rect(cornerRadius: 18, style: .continuous))
                .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
            }
            Text("Scan with the iPhone camera, or tap this Mac under Nearby in Pi Remote and enter:")
              .font(.callout)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
            GlassEffectContainer(spacing: 8) {
              HStack(spacing: 8) {
                ForEach(Array(groups(of: pairing.pairingCode ?? "").enumerated()), id: \.offset) { _, group in
                  Text(group)
                    .font(.system(size: 30, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .tracking(3)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .glassEffect(.regular, in: .rect(cornerRadius: 14, style: .continuous))
                }
              }
            }
            .textSelection(.enabled)
            .opacity(remaining == nil ? 0.35 : 1)
            if let remaining {
              VStack(spacing: 5) {
                ProgressView(value: fraction(until: pairing.pairingExpiresAt, now: context.date))
                  .progressViewStyle(.linear)
                  .frame(width: 150)
                Text("Expires in \(remaining)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
              }
            } else {
              Text("This code has expired.").font(.callout).foregroundStyle(.orange)
              Button("New Code") { Task { await model.startPairing() } }
                .buttonStyle(.glassProminent)
            }
          }
        }
        Button("Cancel") { model.closePairing() }
          .buttonStyle(.glass)
          .keyboardShortcut(.cancelAction)
      }
    }
    .padding(.horizontal, 20)
    .padding(.bottom, 14)
    .frame(maxWidth: .infinity)
  }

  private func groups(of code: String) -> [String] {
    code.count == 6 ? [String(code.prefix(3)), String(code.suffix(3))] : [code]
  }

  private func fraction(until iso: String?, now: Date) -> Double {
    guard let iso, let expires = HubFormatting.date(iso) else { return 0 }
    return min(max(expires.timeIntervalSince(now) / Self.codeLifetime, 0), 1)
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
