# Third-party notices and release gates

## OpenChatCut

This project integrates and patches [0xsline/OpenChatCut](https://github.com/0xsline/OpenChatCut). The pinned source revision is recorded by the `vendor/openchatcut` Git submodule. OpenChatCut's root `LICENSE`, package metadata, and English README identify it as `AGPL-3.0-or-later`; its Chinese README at the reviewed revision contains a conflicting stale no-license statement. This repository conservatively treats the combined source as AGPL and does not claim that a submodule avoids copyleft obligations.

Codex ChatCut must retain upstream copyright and attribution notices when distributing a prepared or modified OpenChatCut build. Host Patch files are provided under AGPL-3.0-or-later.

## ChatCut agent skills

OpenChatCut's `src/agent/skills/NOTICE.md` says those skills were adapted from `ChatCut-Inc/agent-plugin` under `GPL-3.0-only`. Codex ChatCut Host Mode does not package those skills into its plugin skill directory. Their redistribution status must be audited before any release bundles them.

## Remotion

OpenChatCut depends on Remotion. Remotion uses a company-license model in addition to free use for qualifying individuals and small organizations. A public source integration does not grant a Remotion company license. Binary distribution and organizational production use must be checked against the current Remotion license before release.

## Assets, fonts, templates, and media

OpenChatCut includes fonts, templates, shaders, LUTs, thumbnails, sounds, and other assets with separate or incomplete license provenance. The MVP repository references upstream source; release automation must exclude unaudited assets or document an applicable license for every included class of asset.

This notice is an engineering distribution boundary, not legal advice.
