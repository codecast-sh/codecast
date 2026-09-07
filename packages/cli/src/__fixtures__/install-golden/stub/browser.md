
## Browser

Drive a real Chrome (cast browser). Adds `cast browser` so agents can use the web: open a page, read it as text with a handle on every button and field, click, type, screenshot, and read the console and network log while debugging a site. It drives a real Chrome started from a COPY of your profile, so it is signed in to what you are signed in to — your own Chrome is never touched, and `cast browser start --fresh` gives a signed-out one instead. Nothing launches until an agent runs `cast browser start`.

Run `cast guide browser` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-browser -->
