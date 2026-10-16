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
- **Model**:
  - 14-day free trial (no credit card required).
  - One-time purchase ($49–$99 perpetual license with 1 year of updates) OR monthly subscription ($9–$15/month).

---

## 3. Public Verification

- Every binary release includes an automated `SHA256` checksum published on the download page.
- Users can verify authenticity with:
  ```bash
  shasum -a 256 Chorus.dmg
  ```
