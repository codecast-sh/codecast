// Minimal local HAST (HTML AST) type surface used by our rehype plugins.
//
// react-markdown / rehype run on a HAST tree, but `@types/hast` is not a
// resolvable dependency in this workspace. Rather than pull in the full
// upstream package, we declare just the node shapes our plugins touch. These
// mirror the upstream `hast` definitions (https://github.com/syntax-tree/hast)
// closely enough that the trees react-markdown produces are assignable.

export interface Text {
  type: "text";
  value: string;
}

export interface Element {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: ElementContent[];
}

export interface Root {
  type: "root";
  children: RootContent[];
}

/** Content allowed as a direct child of an `Element`. */
export type ElementContent = Element | Text;

/** Content allowed as a direct child of the `Root`. */
export type RootContent = Element | Text;
