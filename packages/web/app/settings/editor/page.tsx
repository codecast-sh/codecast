// Settings > Editor: vim and the vimrc, how code looks, editing, saving, and
// the language servers this machine has. Every control writes the synced
// `code_editor` settings (lib/code/editorSettings.ts), which open editors
// apply live; the vimrc decides whatever was not set here.

import { SettingsPanel } from "../../../components/settings/ui";
import { EditorOptionSections } from "../../../components/settings/editor/EditorOptionSections";
import { LanguageServersSection } from "../../../components/settings/editor/LanguageServersSection";
import { VimSection } from "../../../components/settings/editor/VimSection";
import { useEditorEndpoint } from "../../../components/settings/editor/useEditorEndpoint";
import { useVimConfig } from "../../../components/settings/editor/useVimConfig";
import { hasVimConfig, resolveEditorSettings, settingsFromVimOptions, useExplicitEditorSettings, vimModeOn } from "../../../lib/code/editorSettings";

export default function EditorSettingsPage() {
  const endpoint = useEditorEndpoint();
  const vim = useVimConfig(endpoint);
  const explicit = useExplicitEditorSettings();
  // A vimrc's options ride with vim: with vim off they decide nothing.
  const mode = explicit.vimMode ?? "auto";
  const vimOn = vimModeOn(mode, hasVimConfig(vim.response));
  const resolved = resolveEditorSettings(explicit, vimOn ? settingsFromVimOptions(vim.report?.options.global) : {});
  // Until the config is known, what a vimrc could decide is not known either.
  const vimrcPending = mode !== "off" && !vim.report && !vim.error && endpoint.status !== "offline";
  return (
    <SettingsPanel>
      <VimSection endpoint={endpoint} vim={vim} explicit={explicit} />
      <EditorOptionSections resolved={resolved} vimrcPending={vimrcPending} />
      <LanguageServersSection endpoint={endpoint} />
    </SettingsPanel>
  );
}
