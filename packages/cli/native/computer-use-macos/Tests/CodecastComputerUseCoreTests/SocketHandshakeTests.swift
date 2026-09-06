import XCTest
@testable import CodecastComputerUseCore

final class SocketHandshakeTests: XCTestCase {
    private let castBinary = "/Users/x/.bun/bin/cast"
    private let castPeer = SocketHandshake.Peer(executablePath: "/Users/x/.bun/bin/cast", parentChain: [900, 800])

    func testAMatchingTokenFromTheCastBinaryIsAuthorized() {
        XCTAssertEqual(
            SocketHandshake.evaluate(
                expectedToken: "abc",
                requestToken: "abc",
                peer: castPeer,
                castBinary: castBinary,
                daemonPid: nil
            ),
            .authorized
        )
    }

    func testAWrongTokenIsRefusedBeforeThePeerIsEvenConsidered() {
        let verdict = SocketHandshake.evaluate(
            expectedToken: "abc",
            requestToken: "nope",
            peer: castPeer,
            castBinary: castBinary,
            daemonPid: nil
        )

        XCTAssertEqual(verdict, .invalidToken)
        XCTAssertEqual(verdict.errorCode, .permissionDenied)
        XCTAssertEqual(verdict.message, "invalid computer agent token")
    }

    func testAMissingTokenIsRefused() {
        XCTAssertEqual(
            SocketHandshake.evaluate(
                expectedToken: "abc",
                requestToken: nil,
                peer: castPeer,
                castBinary: castBinary,
                daemonPid: nil
            ),
            .invalidToken
        )
    }

    func testAValidTokenFromAnUnrelatedProcessIsRefused() {
        let stranger = SocketHandshake.Peer(executablePath: "/usr/bin/curl", parentChain: [4, 3])

        let verdict = SocketHandshake.evaluate(
            expectedToken: "abc",
            requestToken: "abc",
            peer: stranger,
            castBinary: castBinary,
            daemonPid: 900
        )

        XCTAssertEqual(verdict, .unauthorizedPeer)
        XCTAssertEqual(verdict.message, "computer agent peer is not authorized")
    }

    func testAPeerUnderTheDaemonIsAuthorizedWithoutMatchingTheBinary() {
        let paneShell = SocketHandshake.Peer(executablePath: "/bin/zsh", parentChain: [700, 600, 500])

        XCTAssertTrue(SocketHandshake.isAuthorizedPeer(paneShell, castBinary: castBinary, daemonPid: 500))
    }

    func testTheParentWalkStopsAfterFourHops() {
        let deep = SocketHandshake.Peer(executablePath: "/bin/zsh", parentChain: [5, 4, 3, 2, 500])

        XCTAssertFalse(SocketHandshake.isAuthorizedPeer(deep, castBinary: castBinary, daemonPid: 500))
    }

    func testAnUnreadablePeerIsRefused() {
        XCTAssertEqual(
            SocketHandshake.evaluate(
                expectedToken: "abc",
                requestToken: "abc",
                peer: nil,
                castBinary: castBinary,
                daemonPid: 500
            ),
            .unauthorizedPeer
        )
    }

    func testTheHandshakeReportsProtocolVersionOneAndTheBuildItCameFrom() throws {
        let payload = try ProviderCapabilities(providerVersion: "1.2.3").jsonObject()

        XCTAssertEqual(payload["protocolVersion"] as? Int, 1)
        XCTAssertEqual(payload["providerVersion"] as? String, "1.2.3")
        XCTAssertEqual(payload["provider"] as? String, "codecast-computer-macos")
        XCTAssertEqual(payload["platform"] as? String, "darwin")
    }

    func testTheHandshakeDeniesTheCapabilitiesTheDesignWithholds() throws {
        let supports = try XCTUnwrap(try ProviderCapabilities(providerVersion: "1.2.3").jsonObject()["supports"] as? [String: Any])
        let windows = try XCTUnwrap(supports["windows"] as? [String: Any])
        let actions = try XCTUnwrap(supports["actions"] as? [String: Any])
        let observation = try XCTUnwrap(supports["observation"] as? [String: Any])

        // No verb an agent can call may focus a window, and drag does not exist.
        XCTAssertEqual(windows["focus"] as? Bool, false)
        XCTAssertEqual(windows["moveResize"] as? Bool, false)
        XCTAssertEqual(actions["drag"] as? Bool, false)
        XCTAssertEqual(actions["setValue"] as? Bool, true)
        XCTAssertEqual(observation["ocr"] as? Bool, false)
        XCTAssertEqual(observation["annotatedScreenshot"] as? Bool, false)
        XCTAssertEqual(observation["screenshot"] as? Bool, true)
    }
}

final class AgentSessionOwnershipTests: XCTestCase {
    private let first = AgentSessionConnectionID(rawValue: 1)
    private let second = AgentSessionConnectionID(rawValue: 2)

    func testTheFirstAuthenticatedConnectionClaimsTheSession() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(first, authenticated: true), .claimed)
    }

    func testAnUnauthenticatedConnectionIsRejected() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(first, authenticated: false), .rejected)
    }

    func testASecondConnectionJoinsTheSameSession() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authenticated: true)

        XCTAssertEqual(ownership.registerConnection(second, authenticated: true), .retained)
    }

    func testTheSameConnectionCannotRegisterTwice() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authenticated: true)

        XCTAssertEqual(ownership.registerConnection(first, authenticated: true), .rejected)
    }

    func testOnlyTheLastHangUpDrainsTheSession() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authenticated: true)
        _ = ownership.registerConnection(second, authenticated: true)

        XCTAssertFalse(ownership.disconnect(first))
        XCTAssertTrue(ownership.disconnect(second))
    }

    func testAnUnknownConnectionDoesNotDrainTheSession() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authenticated: true)

        XCTAssertFalse(ownership.disconnect(second))
    }

    /// Codecast's CLI is short lived, so a drained session must be reclaimable:
    /// the next command reconnects and finds its element indexes still valid.
    func testAReconnectClaimsTheDrainedSessionAgain() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authenticated: true)
        XCTAssertTrue(ownership.disconnect(first))

        XCTAssertEqual(ownership.registerConnection(second, authenticated: true), .claimed)
    }

    func testTheHelperOutlivesItsConnectionsByExactlyTheCacheAge() {
        XCTAssertEqual(ComputerHelperLifetime.idleDeadline, ComputerSnapshotCachePolicy.maxAge)
        XCTAssertEqual(ComputerHelperLifetime.unclaimedDeadline, 30)
    }
}
