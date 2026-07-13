# Rabbithole 구현 기능 및 코드 라우팅

이 문서는 현재 구현된 기능과 각 기능의 코드 위치를 함께 기록한다. 코딩
에이전트는 저장소 전체를 탐색하기 전에 이 문서에서 작업 영역을 고르고,
`먼저 읽기`에 적힌 파일부터 확인한다.

- 확인일: 2026-07-14
- 확인 기준: `d2d3c11`
- 제품 구조: 공유 Core + 공유 UI + MCP(Node) 호스트 + Web(BYOK) 호스트
- 상세 경계: `ARCHITECTURE.md`
- 호환성 규칙: `docs/compatibility.md`
- 테스트 선택법: `docs/testing.md`

## 에이전트용 사용법

1. 아래 표에서 변경하려는 기능을 찾는다.
2. `먼저 읽기` 파일만 우선 연다.
3. 공개 포맷, 두 호스트, 저장소 또는 UI 경계를 넘을 때만 `연관 파일`을 연다.
4. 표의 `관련 테스트`를 가장 먼저 실행한다.
5. UI를 수정했다면 `npm run build && npm run check:dist`를 실행하고 변경된
   `dist/` 번들도 함께 반영한다.
6. schema, `.rabbithole`, snapshot, hydration을 수정한다면 먼저
   `docs/compatibility.md`를 읽고 contract test를 추가한다.

### 어느 레이어에서 시작할지 고르는 기준

| 변경 성격 | 시작 위치 | 이유 |
|---|---|---|
| 두 호스트에서 같아야 하는 문서 동작 | `src/core/` | 모델, reducer, 렌더링, 포맷의 단일 권위 |
| Reader/Canvas의 사용자 상호작용 | `src/ui/` | MCP live, Web, frozen snapshot이 공유하는 UI |
| MCP 도구, 로컬 서버, 파일 저장 | `src/node/` | Node 전용 I/O와 MCP 수명주기 |
| 웹 앱, 모델 provider, IndexedDB | `src/web/` | 브라우저 BYOK 호스트 전용 |
| 공통 shell, CSS, 디자인 토큰 | `src/core/html/` | live/frozen/Web 표면이 공유하는 마크업과 스타일 |
| URL ingestion relay | `workers/fetch-proxy/` | CORS 우회용 선택적 Cloudflare Worker |
| 번들·정적 배포 결과 | `build.mjs`, `scripts/`, `dist/` | 재현 가능한 build/publish 경계 |

## 1. 공유 문서 엔진 (`src/core`)

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] hole/node 상태 생성, hydration projection | `src/core/reducer.js` | `src/core/model.js`, `src/core/schema.js` | `test/unit/reducer.test.mjs`, `test/e2e/reducer-browser-parity.test.mjs` |
| [x] branch 생성, streaming progress, 완료, 삭제, node/view update | `src/core/reducer.js` | `src/core/generation-run.js`, `src/core/hole-host.js` | `test/unit/reducer.test.mjs`, `test/integration/generation-lifecycle.test.mjs` |
| [x] selection·follow-up·lens·synthesis 모델 | `src/core/model.js` | `src/core/reducer.js`, `src/core/prompts/answering-v1.js` | `test/unit/reducer.test.mjs`, `test/e2e/web-app-learning.test.mjs` |
| [x] versioned persisted-hole schema와 검증 | `src/core/schema.js` | `src/core/contracts/artifact.d.ts`, `docs/compatibility.md` | `test/contracts/data-boundaries.test.mjs`, `test/contracts/artifact-roundtrip.test.mjs` |
| [x] Node/Web 공통 storage port | `src/core/store.js` | `src/node/fs-store.js`, `src/web/store/idb-store.js`, `src/core/contracts/store.d.ts` | `test/contracts/filesystem-store.test.mjs`, `test/contracts/indexeddb-store.test.mjs` |
| [x] host 공통 save queue, browser event dispatch, orphan asset 계산 | `src/core/hole-host.js` | `src/node/transport/session.js`, `src/web/transport/direct-host.js` | `test/integration/generation-lifecycle.test.mjs`, `test/contracts/assets.test.mjs` |
| [x] card 기본 크기, subtree bounds, child 배치 | `src/core/layout.js` | `src/ui/canvas-view.js` | `test/e2e/web-app-canvas-sharing.test.mjs`, `test/e2e/reducer-browser-parity.test.mjs` |
| [x] host 공통 generation event 누적과 순서 보장 | `src/core/generation-run.js` | `src/node/transport/generation-ingress.js`, `src/web/transport/direct-host.js` | `test/integration/generation-lifecycle.test.mjs` |
| [x] 타입 경계와 runtime authority 연결 | `src/core/contracts/README.md` | `src/core/contracts/*.d.ts`, `test/fixtures/contracts/` | `test/contracts/data-boundaries.test.mjs` |

## 2. Markdown, 콘텐츠 블록과 프롬프트

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] GFM Markdown, 표, 링크, 이미지, code fence | `src/core/markdown-renderer.js` | `src/core/markdown.js`, `src/ui/renderer.js` | `test/unit/markdown-renderer.test.mjs` |
| [x] KaTeX inline/display 수식과 streaming pending fallback | `src/core/markdown-renderer.js` | `src/core/html/styles.js`, `dist/katex.css` | `test/unit/markdown-renderer.test.mjs`, `test/contracts/compatibility-security.test.mjs` |
| [x] highlight.js 코드 강조와 unknown-language fallback | `src/core/markdown-renderer.js` | `src/ui/renderer.js` | `test/unit/markdown-renderer.test.mjs` |
| [x] raw HTML escape, URL scheme 제한, 안전한 렌더링 | `src/core/markdown-renderer.js` | `src/core/base-url.js`, `src/ui/visuals.js` | `test/contracts/compatibility-security.test.mjs`, `test/unit/base-url.test.mjs` |
| [x] 명시적·frontmatter·상속 `base_url`과 GitHub raw image 변환 | `src/core/base-url.js` | `src/core/markdown-renderer.js` | `test/unit/base-url.test.mjs` |
| [x] `asset:name.ext` 참조, MIME, 이름·크기 제한, 참조 추출 | `src/core/assets.js` | `src/core/base-url.js`, `src/node/fs-store.js`, `src/web/store/idb-store.js` | `test/contracts/assets.test.mjs` |
| [x] durable fenced block ID와 block registry | `src/core/blocks.js` | `src/ui/renderer.js`, `src/core/reducer.js` | `test/unit/content-blocks.test.mjs` |
| [x] sanitized HTML/SVG `show` block | `src/core/blocks.js` | `src/core/markdown-renderer.js`, `src/ui/visuals.js` | `test/unit/content-blocks.test.mjs`, `test/contracts/compatibility-security.test.mjs` |
| [x] inline multiple-choice `check` block와 학습자 상태 저장 | `src/core/blocks.js` | `src/ui/renderer.js`, `src/core/reducer.js` | `test/unit/content-blocks.test.mjs`, `test/e2e/web-app-learning.test.mjs` |
| [x] 답변, 문서 저작, explainer, PDF transcription 프롬프트 | `src/core/prompts/index.js` | `src/core/prompts/answering-v1.js`, `src/core/prompts/authoring-v1.js`, `src/core/prompts/explainer-v1.js`, `src/core/prompts/transcribe-v1.js` | `test/contracts/prompts.test.mjs`, `test/evals/run-eval.mjs` |

## 3. 공유 Reader·Canvas UI (`src/ui`)

### UI 조립과 수명주기

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] live/frozen/Web 공통 UI 조립, capability 주입, dispose | `src/ui/composition.js` | `src/ui/entry.js`, `src/ui/frozen-entry.js`, `src/ui/lifecycle.js` | `test/unit/lifecycle.test.mjs`, `test/contracts/ui-bundle-boundaries.test.mjs` |
| [x] hydration을 브라우저 node state로 초기화 | `src/ui/hydrate.js` | `src/ui/core.js`, `src/core/reducer.js` | `test/e2e/reducer-browser-parity.test.mjs` |
| [x] Markdown을 필요할 때 렌더링하고 block state 연결 | `src/ui/renderer.js` | `src/core/markdown-renderer.js`, `src/ui/visuals.js` | `test/unit/markdown-renderer.test.mjs`, `test/unit/content-blocks.test.mjs` |
| [x] live UI entry와 별도 frozen entry | `src/ui/entry.js` | `src/ui/frozen-entry.js`, `src/ui/composition.js` | `test/contracts/ui-bundle-boundaries.test.mjs`, `test/performance/budgets.test.mjs` |

### Reader와 질문 흐름

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] Reader 문서, breadcrumb, FROM origin jump, sidebar | `src/ui/reader.js` | `src/ui/text-marks.js`, `src/ui/scroll-position.js` | `test/e2e/web-app-learning.test.mjs` |
| [x] 문서별 scroll 복원과 read/unread 상태 | `src/ui/reader.js` | `src/ui/core.js`, `src/ui/transport-status.js` | `test/e2e/web-app-learning.test.mjs`, `test/unit/reducer.test.mjs` |
| [x] 텍스트 선택 질문 popup과 선택 영역 표시 | `src/ui/ask-followups.js` | `src/ui/text-marks.js`, `src/ui/overlay/anchor.js` | `test/e2e/web-app-learning.test.mjs` |
| [x] Explain·ELI5·Example·Go Deeper lens와 1~4 단축키 | `src/ui/ask-followups.js` | `src/core/model.js`, `src/core/prompts/answering-v1.js` | `test/e2e/web-app-learning.test.mjs`, `test/evals/run-eval.mjs` |
| [x] 문서 전체 follow-up thread와 카드 composer | `src/ui/ask-followups.js` | `src/ui/reader.js`, `src/ui/canvas-view.js`, `src/ui/composer-state.js` | `test/e2e/web-app-learning.test.mjs` |
| [x] optimistic branch 생성과 실패 rollback | `src/ui/ask-followups.js` | `src/ui/node-teardown.js`, `src/core/layout.js` | `test/e2e/web-app-learning.test.mjs`, `test/integration/generation-lifecycle.test.mjs` |
| [x] pending·streaming·answered 상태를 Reader/thread/card에 동기화 | `src/ui/transport-status.js` | `src/ui/reader.js`, `src/ui/canvas-view.js`, `src/ui/core.js` | `test/e2e/web-app-learning.test.mjs`, `test/integration/mcp-rearm.test.mjs` |

### Canvas와 탐색

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] infinite pan/zoom, card 생성, drag, resize, collapse | `src/ui/canvas-view.js` | `src/core/layout.js`, `src/ui/easing.js` | `test/e2e/web-app-canvas-sharing.test.mjs` |
| [x] selection origin에 연결되는 edge와 hover 강조 | `src/ui/canvas-view.js` | `src/ui/text-marks.js` | `test/e2e/web-app-canvas-sharing.test.mjs` |
| [x] Frame all, Tidy, 새 node reveal, Reader 전환 | `src/ui/canvas-view.js` | `src/core/layout.js`, `src/ui/palette.js` | `test/e2e/web-app-canvas-sharing.test.mjs` |
| [x] hole 전체 `Cmd/Ctrl+K` 검색과 Canvas command palette | `src/ui/palette.js` | `src/ui/core.js`, `src/ui/canvas-view.js` | `test/e2e/web-app-learning.test.mjs`, `test/e2e/web-app-canvas-sharing.test.mjs` |
| [x] j/k mark 순회, Enter open, Backspace parent, F/T Canvas 키 | `src/ui/chrome-init.js` | `src/ui/reader.js`, `src/ui/canvas-view.js` | `test/e2e/web-app-learning.test.mjs` |
| [x] light/dark theme, 시스템 테마, reduced motion | `src/ui/chrome-init.js` | `src/core/html/tokens.js`, `src/core/html/styles.js` | `test/e2e/web-app-setup.test.mjs`, `test/performance/budgets.test.mjs` |

### 공유·이미지·PDF·접근성

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] 문서/trail Markdown 복사, synthesis, subtree 삭제 | `src/ui/branch-surfaces.js` | `src/ui/node-teardown.js`, `src/ui/ask-followups.js` | `test/e2e/web-app-canvas-sharing.test.mjs` |
| [x] self-contained snapshot 다운로드와 frozen control policy | `src/ui/snapshot.js` | `src/ui/frozen-entry.js`, `src/core/snapshot-projection.js`, `src/core/snapshot-html.js` | `test/contracts/compatibility-security.test.mjs`, `test/integration/artifact-portability.test.mjs` |
| [x] Web 전용 `.rabbithole` export capability 노출 | `src/ui/branch-surfaces.js` | `src/ui/entry.js`, `src/web/portable.js` | `test/e2e/web-app-canvas-sharing.test.mjs`, `test/integration/artifact-portability.test.mjs` |
| [x] 이미지 zoom controls, lightbox, asset URL 수명주기 | `src/ui/image-ux.js` | `src/ui/renderer.js`, `src/core/assets.js` | `test/integration/image-experience.test.mjs` |
| [x] native PDF page, selectable text layer, box-select region | `src/ui/pdf-view.js` | `src/ui/text-marks.js`, `src/core/pdf-shared.js` | `test/unit/pdf-selection.test.mjs`, `test/integration/pdf-node-conversion.test.mjs` |
| [x] PDF를 searchable Markdown 문서로 변환하는 UI와 cancel/progress | `src/ui/pdf-view.js` | `src/node/transport/session.js`, `src/web/transport/direct-host.js` | `test/integration/pdf-conversion.test.mjs`, `test/unit/pdf-transcription-capability.test.mjs` |
| [x] overlay stack, anchored surface, focus trap | `src/ui/overlay/layer-stack.js` | `src/ui/overlay/anchor.js`, `src/ui/focus-trap.js` | `test/e2e/ui-primitives-browsers.test.mjs` |
| [x] Button, Field, Popover, Dialog, Notice, Combobox primitives | `src/ui/primitives/` | `src/core/html/button-markup.js`, `src/core/html/styles.js` | `test/e2e/ui-primitives-browsers.test.mjs` |

## 4. MCP·Node 호스트 (`src/node`)

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] stdio MCP 서버, 도구 등록, stderr logging, graceful shutdown | `src/node/mcp/server.js` | `bin/mcp-server.js`, `src/node/logger.js`, `src/node/sessions.js` | `test/packaging/install-smoke.test.mjs` |
| [x] `open_rabbithole`, `answer_branch`, `list_rabbitholes` schema와 설명 | `src/node/tools/manifest.js` | `src/node/mcp/schema.js`, `src/node/rabbithole.js` | `test/contracts/assets.test.mjs`, `test/contracts/mcp-markdown-wire.test.mjs` |
| [x] 새 Markdown hole 생성과 저장된 hole 재개 | `src/node/rabbithole.js` | `src/node/fs-store.js`, `src/node/sessions.js` | `test/e2e/cross-host-journey.test.mjs`, `test/contracts/filesystem-store.test.mjs` |
| [x] answer chunk 누적, partial streaming, 최종 답변 | `src/node/transport/generation-ingress.js` | `src/node/transport/session.js`, `src/core/generation-run.js` | `test/integration/generation-lifecycle.test.mjs`, `test/contracts/mcp-markdown-wire.test.mjs` |
| [x] blocking wait, `keep_listening`, reattach, durable ask requeue | `src/node/transport/session.js` | `src/node/rabbithole.js`, `src/node/sessions.js` | `test/integration/mcp-rearm.test.mjs` |
| [x] local HTTP, SSE replay, health, browser event ingress | `src/node/transport/session-router.js` | `src/node/transport/session.js`, `src/node/transport/http.js`, `src/node/transport/sse.js` | `test/integration/mcp-rearm.test.mjs`, `test/contracts/assets.test.mjs` |
| [x] session timeout, disconnect grace, answer watchdog, save debounce | `src/node/transport/session.js` | `src/core/hole-host.js`, `src/node/transport/http.js` | `test/integration/mcp-rearm.test.mjs`, `test/performance/budgets.test.mjs` |
| [x] filesystem hole/asset CRUD, atomic save, staging, GC | `src/node/fs-store.js` | `src/core/store.js`, `src/core/schema.js`, `src/core/assets.js` | `test/contracts/filesystem-store.test.mjs`, `test/integration/pdf-gc.test.mjs` |
| [x] 로컬 PDF 판별, JPEG page rendering, text/geometry 추출 | `src/node/pdf-ingest.js` | `src/core/pdf-shared.js`, `src/node/rabbithole.js` | `test/integration/pdf-ingestion.test.mjs`, `test/unit/pdf-ingest-staging.test.mjs` |
| [x] PDF selection region과 figure crop | `src/node/pdf-crop.js` | `src/node/transport/session.js`, `src/core/pdf-shared.js` | `test/integration/pdf-conversion.test.mjs`, `test/integration/pdf-node-conversion.test.mjs` |
| [x] PDF convert request를 MCP agent transcription으로 연결 | `src/node/transport/session.js` | `src/node/tools/manifest.js`, `src/core/prompts/transcribe-v1.js` | `test/integration/pdf-conversion.test.mjs` |
| [x] live Canvas HTML 조립과 committed bundle 로딩 | `src/node/html/canvas.js` | `src/node/html/built-assets.js`, `dist/client.js` | `test/contracts/ui-bundle-boundaries.test.mjs`, `test/packaging/install-smoke.test.mjs` |
| [x] referenced-assets-only frozen snapshot export | `src/node/transport/session-export.js` | `src/node/transport/session-router.js`, `src/core/snapshot-projection.js`, `src/core/snapshot-html.js` | `test/integration/image-experience.test.mjs`, `test/contracts/compatibility-security.test.mjs` |
| [x] macOS/Windows/Linux 기본 브라우저 열기와 headless mode | `src/node/transport/browser.js` | `src/node/transport/session.js` | `test/packaging/install-smoke.test.mjs` |

## 5. Web BYOK 호스트 (`src/web`)

### 앱 shell과 로컬 library

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] static web app boot, blank Canvas, 새 hole composer | `src/web/app.js` | `src/web/styles.css`, `src/core/html/shell.js` | `test/e2e/web-app-setup.test.mjs` |
| [x] 질문으로 새 explainer 문서 생성 | `src/web/app.js` | `src/web/transport/direct-host.js`, `src/web/brain/openai-compatible.js` | `test/e2e/web-app-learning.test.mjs`, `test/integration/generation-lifecycle.test.mjs` |
| [x] Markdown/PDF/URL/portable/snapshot file 시작 경로와 drag-and-drop | `src/web/app.js` | `src/web/ingest/pdf.js`, `src/web/ingest/url.js`, `src/web/portable.js` | `test/integration/web-ingestion.test.mjs`, `test/e2e/web-app-setup.test.mjs` |
| [x] 저장된 hole rail, 전환, 삭제·undo, browser history | `src/web/app.js` | `src/web/hole-id.js`, `src/web/store/idb-store.js` | `test/e2e/web-app-setup.test.mjs`, `test/e2e/web-app-learning.test.mjs` |
| [x] 기억하기 쉬운 로컬 hole URL slug | `src/web/hole-id.js` | `src/web/app.js` | `test/unit/hole-id.test.mjs` |
| [x] hole 전환 시 UI/transport/save/object URL 정리 | `src/web/app.js` | `src/ui/composition.js`, `src/web/transport/direct-host.js` | `test/unit/lifecycle.test.mjs`, `test/e2e/web-app-learning.test.mjs` |

### Browser generation과 provider 설정

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] reducer 기반 browser generation host와 persistence queue | `src/web/transport/direct-host.js` | `src/core/reducer.js`, `src/core/hole-host.js` | `test/integration/generation-lifecycle.test.mjs`, `test/e2e/reducer-browser-parity.test.mjs` |
| [x] OpenAI-compatible streaming chat completions adapter | `src/web/brain/openai-compatible.js` | `src/web/brain/generation-events.js`, `src/web/brain/errors.js` | `test/integration/generation-lifecycle.test.mjs` |
| [x] OpenRouter preset과 local OpenAI-compatible preset | `src/web/brain/provider-registry.js` | `src/web/brain/index.js`, `src/web/settings/settings-popover.js` | `test/integration/artifact-portability.test.mjs`, `test/e2e/web-app-setup.test.mjs` |
| [x] OpenRouter live model catalog, 검색, 가격 표시 | `src/web/brain/model-catalog.js` | `src/web/settings/settings-popover.js` | `test/e2e/web-app-setup.test.mjs` |
| [x] Ollama/LM Studio/llama.cpp 호환 local model discovery | `src/web/brain/local-model-catalog.js` | `src/web/settings/settings-popover.js` | `test/e2e/web-app-setup.test.mjs` |
| [x] provider key 검증과 복구 가능한 오류 정규화 | `src/web/settings/key-validation.js` | `src/web/brain/errors.js`, `src/web/settings/settings-popover.js` | `test/e2e/web-app-setup.test.mjs`, `test/integration/generation-lifecycle.test.mjs` |
| [x] API key의 local/session-only 저장과 설정 저장 | `src/web/settings/credential-store.js` | `src/web/settings/preferences-store.js`, `src/web/settings/setup-readiness.js` | `test/contracts/data-boundaries.test.mjs`, `test/e2e/web-app-setup.test.mjs` |
| [x] PDF transcription용 vision model capability 감지 | `src/web/brain/pdf-transcription.js` | `src/web/settings/settings-popover.js`, `src/ui/pdf-view.js` | `test/unit/pdf-transcription-capability.test.mjs`, `test/integration/pdf-conversion.test.mjs` |

### Browser 저장·ingestion·portable

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] IndexedDB hole/asset/staging/summary 저장 | `src/web/store/idb-store.js` | `src/core/store.js`, `src/core/schema.js` | `test/contracts/indexeddb-store.test.mjs` |
| [x] browser PDF rendering, text geometry, staged asset adoption | `src/web/ingest/pdf.js` | `src/core/pdf-shared.js`, `src/web/store/idb-store.js` | `test/integration/web-ingestion.test.mjs`, `test/integration/pdf-ingestion.test.mjs` |
| [x] URL ingestion, arXiv HTML 처리, CORS proxy fallback | `src/web/ingest/url.js` | `workers/fetch-proxy/index.js`, `src/web/settings/preferences-store.js` | `test/integration/web-ingestion.test.mjs`, `test/contracts/fetch-proxy-worker.test.mjs` |
| [x] Web PDF region/figure crop | `src/web/pdf-crop.js` | `src/ui/pdf-view.js`, `src/web/transport/direct-host.js` | `test/integration/pdf-node-conversion.test.mjs` |
| [x] `.rabbithole` export/import와 snapshot HTML import | `src/web/portable.js` | `src/core/portable-projection.js`, `src/core/portable-import.js`, `src/core/snapshot-projection.js`, `src/core/snapshot-html.js` | `test/integration/artifact-portability.test.mjs`, `test/contracts/artifact-roundtrip.test.mjs` |
| [x] export에서 credential-shaped field 제거 | `src/web/portable.js` | `src/core/portable-projection.js` | `test/contracts/data-boundaries.test.mjs`, `test/contracts/compatibility-security.test.mjs` |
| [x] 브라우저 테스트용 public behavior seam | `src/web/test-seam.js` | `src/web/app.js` | `test/e2e/web-app-setup.test.mjs`, `test/e2e/web-app-learning.test.mjs`, `test/e2e/web-app-canvas-sharing.test.mjs` |

## 6. PDF 기능의 빠른 파일 선택

PDF는 네 레이어에 걸쳐 있으므로 증상에 따라 아래 한 줄만 먼저 읽는다.

| 작업 | 먼저 읽기 | 다음 파일 |
|---|---|---|
| page asset 이름, 제한값, text geometry, PDF extension 포맷 | `src/core/pdf-shared.js` | `test/unit/pdf-provenance.test.mjs`, `test/unit/pdf-selection.test.mjs`, `test/unit/pdf-ingest-staging.test.mjs` |
| MCP에서 PDF 파일을 page JPEG로 변환 | `src/node/pdf-ingest.js` | `src/node/rabbithole.js` |
| Web에서 PDF 파일 ingestion | `src/web/ingest/pdf.js` | `src/web/app.js` |
| PDF page·text layer·box selection UI | `src/ui/pdf-view.js` | `src/ui/text-marks.js` |
| box-selected 영역 crop | MCP: `src/node/pdf-crop.js` | Web: `src/web/pdf-crop.js` |
| PDF를 Markdown 문서로 전환 | `src/ui/pdf-view.js` | MCP: `src/node/transport/session.js`; Web: `src/web/transport/direct-host.js` |
| transcription prompt와 vision provider | `src/core/prompts/transcribe-v1.js` | `src/web/brain/pdf-transcription.js` |
| PDF portable/snapshot 크기 제한 | `src/core/portable-import.js` | `test/integration/pdf-portability-caps.test.mjs` |

## 7. Portable 파일, snapshot과 보안 경계

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] versioned `.rabbithole` projection과 base64 asset | `src/core/portable-projection.js` | `src/web/portable.js`, `src/core/contracts/artifact.d.ts` | `test/contracts/artifact-roundtrip.test.mjs` |
| [x] portable/snapshot payload 파싱과 파일·node·asset cap | `src/core/portable-import.js` | `src/core/schema.js` | `test/contracts/data-boundaries.test.mjs`, `test/integration/pdf-portability-caps.test.mjs` |
| [x] shareable state만 포함하는 snapshot projection | `src/core/snapshot-projection.js` | `src/core/portable-projection.js` | `test/contracts/compatibility-security.test.mjs` |
| [x] sanitizer, CSS, assets, frozen bundle을 넣은 단일 HTML | `src/core/snapshot-html.js` | `src/ui/snapshot.js`, `src/node/transport/session-export.js` | `test/contracts/compatibility-security.test.mjs`, `test/integration/image-experience.test.mjs` |
| [x] current schema/format만 수용하고 future version 명시적 거절 | `src/core/schema.js` | `src/core/portable-import.js`, `docs/compatibility.md` | `test/contracts/data-boundaries.test.mjs`, `test/contracts/filesystem-store.test.mjs`, `test/contracts/indexeddb-store.test.mjs` |
| [x] frozen bundle에 live transport/provider/settings 코드 유입 방지 | `src/ui/frozen-entry.js` | `build.mjs`, `scripts/check-ui-purity.mjs` | `test/contracts/ui-bundle-boundaries.test.mjs` |
| [x] credential과 device-local preference의 artifact 제외 | `src/web/portable.js` | `src/web/settings/credential-store.js`, `src/core/snapshot-projection.js` | `test/contracts/compatibility-security.test.mjs`, `test/contracts/data-boundaries.test.mjs` |

## 8. 공통 HTML, 디자인 시스템과 UI primitives

| 구현된 기능 | 먼저 읽기 | 연관 파일 | 관련 테스트 |
|---|---|---|---|
| [x] Reader/Canvas/overlay 공통 DOM shell | `src/core/html/shell.js` | `src/core/html/button-markup.js`, `src/core/html/bunny-markup.js` | `test/e2e/ui-primitives-browsers.test.mjs` |
| [x] light/dark token, spacing, layer, control contract | `src/core/html/tokens.js` | `docs/design-system.md` | `test/e2e/ui-primitives-browsers.test.mjs` |
| [x] 문서·Canvas·PDF·Web 공통 stylesheet | `src/core/html/styles.js` | `src/web/styles.css` | `test/e2e/web-app-setup.test.mjs`, `test/e2e/web-app-learning.test.mjs`, `test/e2e/web-app-canvas-sharing.test.mjs`, `test/performance/budgets.test.mjs` |
| [x] accessible button markup helper | `src/core/html/button-markup.js` | `src/ui/primitives/` | `test/e2e/ui-primitives-browsers.test.mjs` |
| [x] surface placement와 overlay dismissal stack | `src/ui/overlay/layer-stack.js` | `src/ui/overlay/anchor.js`, `src/ui/primitives/popover.js`, `src/ui/primitives/dialog.js` | `test/e2e/ui-primitives-browsers.test.mjs` |

UI를 바꿀 때는 `docs/design-system.md`와 `src/core/html/README.md`를 먼저 읽고,
inline style이나 임의 z-index 대신 기존 token과 primitive를 사용한다.

## 9. Build, 배포와 패키징

| 구현된 기능 | 먼저 읽기 | 생성물/연관 파일 | 검증 명령 또는 테스트 |
|---|---|---|---|
| [x] live·frozen UI bundle과 static Web app build | `build.mjs` | `dist/client.js`, `dist/frozen-client.js`, `web/dist/` | `npm run build` |
| [x] DOMPurify와 KaTeX CSS/font self-contained vendor asset | `build.mjs` | `dist/dompurify.js`, `dist/katex.css` | `npm run check:dist` |
| [x] committed `dist/` 재현성 검사 | `scripts/check-dist.mjs` | `dist/` | `npm run check:dist` |
| [x] core/UI dependency purity 검사 | `scripts/check-ui-purity.mjs` | `ARCHITECTURE.md` | `npm run check:purity` |
| [x] public Cloudflare Pages payload 조립 | `scripts/build-publish.mjs` | `website/public/`, `publish/` | `npm run build:publish` |
| [x] URL fetch proxy Worker | `workers/fetch-proxy/index.js` | `workers/fetch-proxy/wrangler.toml` | `test/contracts/fetch-proxy-worker.test.mjs` |
| [x] GitHub `npx` clean-install 실행 | `package.json` | `bin/mcp-server.js`, committed `dist/` | `npm run test:packaging` |

UI source 변경 시 `dist/`는 선택 사항이 아니라 배포 입력이다. GitHub `npx`
설치는 `prepare` build 없이 committed bundle을 직접 사용한다.

## 10. 테스트 라우팅

| 변경 범위 | 먼저 실행 | 전체 확인 |
|---|---|---|
| 순수 Core 함수, reducer, Markdown, PDF 계산 | 해당 `test/unit/*.test.mjs` | `npm run test:unit` |
| schema, store, MCP wire, artifact, 보안 제한 | 해당 `test/contracts/*.test.mjs` | `npm run test:contracts` |
| 하나의 기능이 host 경계를 넘음 | 해당 `test/integration/*.test.mjs` | `npm run test:integration` |
| 실제 Reader/Canvas/Web 사용자 흐름 | 해당 `test/e2e/*.test.mjs` | `npm run test:e2e` |
| bundle·snapshot 크기 또는 시간 | `test/performance/budgets.test.mjs` | `npm run test:performance` |
| npm 배포물과 MCP 시작 | `test/packaging/install-smoke.test.mjs` | `npm run test:packaging` |
| UI source 또는 build 변경 | 관련 테스트 + build | `npm run build && npm run check:dist` |
| 레이어 import 변경 | 관련 테스트 | `npm run check:purity` |
| JSDoc/contract type 변경 | 관련 contract test | `npm run check:types` |
| 전 범위 | 좁은 테스트부터 | `npm test` |

## 11. 현재 구현의 주요 제약

- MCP live page와 frozen snapshot은 외부 runtime asset이 없는 단일
  self-contained HTML이어야 한다.
- Markdown이 문서 콘텐츠의 권위이며 rendered HTML은 파생 값이다.
- `src/core`는 Node built-in, `src/ui`, `src/node`를 import할 수 없다.
- `src/ui`는 browser-only이며 Node/Web host 내부 구현을 import하지 않는다.
- Node와 Web host는 서로 import하지 않는다.
- 현재가 아닌 schema와 portable format은 lossy migration하지 않고 명시적으로 거절한다.
- API key와 provider preference는 hole, `.rabbithole`, snapshot에 포함하지 않는다.
- UI 수정은 source와 재생성된 `dist/`를 함께 반영해야 한다.
- PDF native rendering은 `@napi-rs/canvas` 사용 가능 여부와 asset 크기 제한의
  영향을 받으며, portable import/export cap은 `src/core/portable-import.js`가 정한다.
