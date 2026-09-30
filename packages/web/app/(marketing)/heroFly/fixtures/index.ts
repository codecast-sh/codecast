/** Every chapter's entity fixtures, merged for the sandbox's EntityFixtureContext. */

import type { EntityFixture } from "@/lib/entityDisplay";
import { entities as inbox } from "./inbox";
import { entities as conversation } from "./conversation";
import { entities as fanout } from "./fanout";
import { entities as phone } from "./phone";
import { entities as talk } from "./talk";
import { entities as decide } from "./decide";
import { entities as work } from "./work";
import { entities as automation } from "./automation";
import { entities as team } from "./team";
import { entities as integrations } from "./integrations";
import { entities as publish } from "./publish";
import { entities as memory } from "./memory";
import { entities as remote } from "./remote";

export const HERO_ENTITIES: Record<string, EntityFixture> = {
  ...inbox, ...conversation, ...fanout, ...phone, ...talk, ...decide, ...work, ...automation, ...team, ...integrations, ...publish, ...memory, ...remote,
};
