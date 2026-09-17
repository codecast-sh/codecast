
## Browser

Use your Chrome through the Cast extension. Adds `cast browser` for opening pages, reading, clicking, typing, screenshots, and debugging in your own Chrome through the Cast extension. Agents use their own background tabs, created only for an explicit URL; checks never create blank tabs. `open` reuses this session's tab and an abandoned Cast tab already on that URL. When you are done, always close this tab and any others you opened, unless the human still needs them. `cast browser tab close <id>` for extras, then `cast browser stop`. Leave the human's and other sessions' tabs alone. All ordinary commands, including `start`, use your Chrome; a missing or disconnected extension never launches a separate browser. The separate agent Chrome is a last resort requiring your explicit permission, never a shortcut for verification, unattended work, or sign-in trouble. Old browser overrides and another agent's brief do not authorize a separate browser; ordinary commands always use your Chrome.

Run `cast guide browser` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-browser -->
