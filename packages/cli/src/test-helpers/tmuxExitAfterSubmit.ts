export {};

let input = "";
let composer = "";
const render = () => process.stdout.write(`\x1b[2J\x1b[H${"─".repeat(80)}\r\n❯ ${composer}\r\n${"─".repeat(80)}\r\n  bypass permissions on (shift+tab to cycle)`);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  while (input.length) {
    if (input.startsWith("\x1b[200~")) {
      const end = input.indexOf("\x1b[201~", 6);
      if (end < 0) return;
      composer += input.slice(6, end);
      input = input.slice(end + 6);
      render();
    } else if ("\x1b[200~".startsWith(input)) {
      return;
    } else if (input[0] === "\r") {
      process.stdout.write("\x1b[2J\x1b[HResume this session with:\r\nclaude --resume fixture\r\n$ ", () => process.exit(1));
      process.stdin.pause();
      return;
    } else {
      // Typed input, as an idle composer receives it: C-j is a newline, C-k or
      // C-u clears, other control bytes do nothing.
      const key = input[0];
      input = input.slice(1);
      if (key === "\x0b" || key === "\x15") composer = "";
      else if (key === "\n" || key >= " ") composer += key;
      render();
    }
  }
});
setInterval(() => {}, 1000);
render();
