import { expect, test } from "bun:test";
import { slackParts } from "../slackParts";

test("Slack markup in a quoted report reads as a mention, a named link and plain words (ct-59557)", () => {
  expect(slackParts("<@U06T0M62Y04> <https://unionmatching.com/admin/contacts/90c9|Christopher Nelson> call tips aren't working")).toEqual([
    { mention: "U06T0M62Y04", name: null },
    " ",
    { link: "https://unionmatching.com/admin/contacts/90c9", label: "Christopher Nelson" },
    " call tips aren't working",
  ]);
  expect(slackParts("see <https://x.io> in <#C1|ops>, mail <mailto:a@b.co>")).toEqual(["see ", { link: "https://x.io", label: "https://x.io" }, " in #ops, mail ", { link: "mailto:a@b.co", label: "a@b.co" }]);
  expect(slackParts("no markup <here>")).toEqual(["no markup <here>"]);
});
