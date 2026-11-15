// This Mac's device key (deviceKey.js, convex/deviceKeys.ts): a P-256 key in
// the Secure Enclave that signs only after Touch ID or the login password.
// CryptoKit hands back the key as an encrypted blob only this Mac's enclave
// can use, so it is stored in a plain file and needs no keychain entitlement.
// Each call blocks until the person answers the system prompt; the N-API side
// (deviceKey.mm) runs it on a worker thread. Answers are JSON strings the
// caller frees.
import CryptoKit
import Foundation
import LocalAuthentication

private func b64url(_ d: Data) -> String {
  d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

private func fromB64url(_ s: String) -> Data? {
  var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  while t.count % 4 != 0 { t += "=" }
  return Data(base64Encoded: t)
}

private func answer(_ obj: [String: Any]) -> UnsafeMutablePointer<CChar> {
  let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"error\":\"encode\"}".utf8)
  return strdup(String(decoding: data, as: UTF8.self))!
}

/** The person dismissing the prompt answers `cancelled`, quietly; anything else says what failed. */
private func failure(_ error: Error) -> UnsafeMutablePointer<CChar> {
  var e = error as NSError
  while e.domain != LAErrorDomain, let inner = e.userInfo[NSUnderlyingErrorKey] as? NSError { e = inner }
  if e.domain == LAErrorDomain, [LAError.userCancel, .appCancel, .systemCancel, .userFallback].map({ $0.rawValue }).contains(e.code) {
    return answer(["cancelled": true])
  }
  return answer(["error": (error as NSError).localizedDescription])
}

private func context(_ reason: UnsafePointer<CChar>) -> LAContext {
  let ctx = LAContext()
  ctx.localizedReason = String(cString: reason)
  return ctx
}

@_cdecl("cc_dk_available")
public func ccDkAvailable() -> Bool {
  SecureEnclave.isAvailable
}

/** A new key, and its signature over `message`, which takes the person's Touch ID: { blob, public_key, signature }. */
@_cdecl("cc_dk_create")
public func ccDkCreate(_ message: UnsafePointer<CChar>, _ reason: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar> {
  var cfError: Unmanaged<CFError>?
  guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &cfError) else {
    return answer(["error": "This Mac cannot hold a Touch ID key"])
  }
  do {
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: context(reason))
    let signature = try key.signature(for: Data(String(cString: message).utf8))
    return answer([
      "blob": b64url(key.dataRepresentation),
      "public_key": b64url(key.publicKey.x963Representation),
      "signature": b64url(signature.rawRepresentation),
    ])
  } catch {
    return failure(error)
  }
}

/** The key `blob` names signs `message` once the person answers Touch ID: { signature }. */
@_cdecl("cc_dk_sign")
public func ccDkSign(_ blob: UnsafePointer<CChar>, _ message: UnsafePointer<CChar>, _ reason: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar> {
  guard let data = fromB64url(String(cString: blob)) else { return answer(["error": "The Touch ID key on this Mac is unreadable"]) }
  do {
    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data, authenticationContext: context(reason))
    let signature = try key.signature(for: Data(String(cString: message).utf8))
    return answer(["signature": b64url(signature.rawRepresentation)])
  } catch {
    return failure(error)
  }
}
