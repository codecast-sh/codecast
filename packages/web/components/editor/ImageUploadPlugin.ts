import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

const pluginKey = new PluginKey("imageUploadPlaceholder");

export const ImageUploadPlaceholder = Extension.create({
  name: "imageUploadPlaceholder",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        state: {
          init() {
            return DecorationSet.empty;
          },
          apply(tr, set) {
            set = set.map(tr.mapping, tr.doc);
            const action = tr.getMeta(pluginKey);
            if (action?.add) {
              const { id, pos, previewUrl } = action.add;
              const widget = buildPlaceholderWidget(previewUrl);
              const deco = Decoration.widget(pos, widget, { id });
              set = set.add(tr.doc, [deco]);
            }
            if (action?.remove) {
              const found = set.find(
                undefined,
                undefined,
                (spec) => spec.id === action.remove.id
              );
              if (found.length) set = set.remove(found);
            }
            return set;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

function buildPlaceholderWidget(previewUrl?: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "image-upload-placeholder";

  if (previewUrl) {
    const img = document.createElement("img");
    img.src = previewUrl;
    img.className = "image-upload-preview";
    wrapper.appendChild(img);
  }

  const overlay = document.createElement("div");
  overlay.className = "image-upload-overlay";

  const spinner = document.createElement("div");
  spinner.className = "image-upload-spinner";
  overlay.appendChild(spinner);

  wrapper.appendChild(overlay);
  return wrapper;
}

export function addPlaceholder(view: EditorView, id: string, pos: number, file?: File) {
  const previewUrl = file ? URL.createObjectURL(file) : undefined;
  const tr = view.state.tr;
  tr.setMeta(pluginKey, { add: { id, pos, previewUrl } });
  view.dispatch(tr);
  return previewUrl;
}

export function removePlaceholder(view: EditorView, id: string, previewUrl?: string) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  const tr = view.state.tr;
  tr.setMeta(pluginKey, { remove: { id } });
  view.dispatch(tr);
}

export function findPlaceholderPos(view: EditorView, id: string): number | null {
  const decos = pluginKey.getState(view.state) as DecorationSet;
  if (!decos) return null;
  const found = decos.find(undefined, undefined, (spec) => spec.id === id);
  return found.length ? found[0].from : null;
}

export function uploadImageWithPlaceholder(
  view: EditorView,
  file: File,
  pos: number,
  uploadFn: (file: File) => Promise<string | null>
) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const previewUrl = addPlaceholder(view, id, pos, file);
  uploadFn(file).then((url) => {
    const placeholderPos = findPlaceholderPos(view, id);
    removePlaceholder(view, id, previewUrl);
    if (url && placeholderPos != null) {
      view.dispatch(
        view.state.tr.insert(
          placeholderPos,
          view.state.schema.nodes.image.create({ src: url })
        )
      );
    }
  });
}
