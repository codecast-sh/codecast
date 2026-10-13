
## iOS Simulator

Drive iOS simulators from a shared pool, on a laptop or a cloud Mac (cast sim). Adds `cast sim` so agents share a machine's iOS simulators instead of booting their own: a session acquires one from the pool, installs and launches a build, screenshots into the thread, reads the accessibility tree and taps, types and swipes by label or point. The lock ends with the session and idle simulators are shut down for you, and the same commands work on a cloud Mac, so simulator work can move off the laptop.

Run `cast guide sim` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-sim -->
