
## iOS Simulator

`cast sim` gives this session an iOS simulator from the machine's shared pool, on a laptop or a cloud Mac alike, and drives it. Use it for anything that runs in a simulator, instead of raw `xcrun simctl`, `axe` or the old `sim-*` scripts.

```bash
cast sim acquire                        # take a free simulator for this session and boot it
cast sim install path/To.app --launch   # or: cast sim launch <bundle-id>
cast sim shot                           # screenshot into the thread
cast sim ui                             # the accessibility tree, each element with its tap point
cast sim tap --label "Sign in"          # or -x/-y in points; type, swipe and button work the same way
cast sim release                        # give it back when done
```

The lock belongs to this session, so every verb targets your simulator without a UDID. Never boot, shut down or erase a simulator you do not hold, and don't count on one staying booted across a long gap. `cast guide sim` covers coordinates, other axe verbs and cloud Macs.
<!-- cast @VERSION@ -->
<!-- /codecast-sim -->
