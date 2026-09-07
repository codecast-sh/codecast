
## Computer

Drive a native macOS app (cast computer). Adds `cast computer` so agents can work in desktop apps the way they already work in a web page: read one window as an indexed tree of its buttons, fields and text, then click, scroll, type or write a value into a single element by its index. It runs through a small signed helper that you grant Accessibility and Screen Recording once, so no other codecast binary ever asks. Password managers are refused outright, password fields read as `[redacted]`, and no verb brings a window to the front unless the agent explicitly asks for it.

Run `cast guide computer` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-computer -->
