// swift-tools-version: 6.0

import PackageDescription

// The helper the `cast computer` CLI materializes and drives over a unix socket.
// Structure and several test cases are adapted from stablyai/orca (MIT); the
// protocol, lifetime, focus policy and safety rules are codecast's own.
let package = Package(
    name: "CodecastComputerUse",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "CodecastComputerUseCore",
            targets: ["CodecastComputerUseCore"]
        ),
        .executable(
            name: "codecast-computer",
            targets: ["CodecastComputerUse"]
        )
    ],
    targets: [
        .target(
            name: "CodecastComputerUseCore",
            path: "Sources/CodecastComputerUseCore"
        ),
        .executableTarget(
            name: "CodecastComputerUse",
            dependencies: ["CodecastComputerUseCore"],
            path: "Sources/CodecastComputerUse"
        ),
        .testTarget(
            name: "CodecastComputerUseCoreTests",
            dependencies: ["CodecastComputerUseCore"],
            path: "Tests/CodecastComputerUseCoreTests"
        )
    ]
)
