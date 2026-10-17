# Distribution & Trust Strategy — Chorus

## 1. Eliminating OS Security Warnings

Non-technical users flee if an operating system displays warning popups ("Unverified Developer", "Malicious Software").

### A. macOS: Apple Notarization
- **Requirement**: Apple Developer Program membership ($99/year).
- **Process**:
  1. Build `.app` or `.dmg`.
  2. Sign using `Developer ID Application` certificate.
  3. Submit to Apple via `xcrun notarytool submit`.
  4. Staple ticket to the disk image: `xcrun stapler staple Chorus.dmg`.
- **Result**: macOS displays a clean prompt: *"Chorus was verified by Apple. Open?"*

### B. Windows: Code Signing & SmartScreen
- **Requirement**: Windows Code Signing Certificate.
- **Recommended Provider**: Azure Trusted Signing (~$10/month) or SignPath.io.
- **Result**: Eliminates the blue "Windows protected your PC" screen.

---

## 2. Monetization & Merchant of Record (MoR)

To sell software globally without managing 100+ country tax filings:
- **Platform**: **Polar.sh** (Developer-friendly, low fees ~4%, built-in license key issuance) or **Lemon Squeezy**.
- **Model**: **$5 one-time, lifetime license** (see [product.md](product.md) for the goal and the fee math).
  - At $5 the fixed per-sale fee matters: expect ≈ $4.30 net per sale.
  - License key issued by the platform, checked once and stored locally. No heavy anti-piracy work.
  - Optional: a free tier with $5 unlocking everything, for word of mouth (decide before launch).
- **Platforms to ship first:** macOS (sign + notarize with an Apple Developer ID, $99/year). Windows later,
  with Azure Artifact Signing (~$10/month, individuals in the USA/Canada or organizations in the
  USA/Canada/EU/UK) or an OV certificate otherwise. Not the Mac App Store: its sandbox can't run other CLIs.

---

## 3. Public Verification

- Every binary release includes an automated `SHA256` checksum published on the download page.
- Users can verify authenticity with:
  ```bash
  shasum -a 256 Chorus.dmg
  ```
