# designstudio-html → VSCode 확장팩 재포팅 설계서

> 대상 산출 경로: `C:\workspace\claude-designstudio\designstudio-html-vscode\`
> 작성: 시니어 VSCode 확장 아키텍트 / 본 문서는 **설계·계획만** 담는다(코드 없음).
> 근거: 조사결과 A(로딩계약), B(프록시계약), C(VSCode 공식 검증) + 실제 소스 검수
> (`designstudio-html/index.html`, `server.js`, `worker.js`, `sample.html` 및 기존 `designstudio-vscode/extension.js`·`media/host-adapter.js`).

---

## 1. 개요 / 목표 / 비목표(scope)

### 1.1 배경
`designstudio-html`은 단일 거대 SPA(`index.html`)에 Node `server.js`(정적 서빙 + `/api/proxy` SSRF 안전 프록시 + 선택적 Basic 인증)와 Cloudflare `worker.js`(동일 프록시 계약, 엣지)를 결합한 **서버 의존형** 비주얼 HTML 에디터다. 핵심 편집 메커니즘은 미리보기 `iframe`의 **같은-출처 `contentDocument` 직접 조작**(스타일 주입 + mouseover/click 리스너 부착)이다.

기존 `designstudio-vscode`는 "에디터 코드 무수정 + host-adapter.js로 `downloadToBrowser`만 후킹"하는 **얇은 명령형 패널** 패턴으로 동작한다. 그러나 그 패턴은 (a) 서버 결합점(`/sample.html`, `/api/proxy`)을 해결하지 못하고, (b) 원본 파일 in-place 저장이 아니라 다운로드형 저장이며, (c) i18n 쿠키 영속성이 webview에서 불안정하다.

### 1.2 목표 (In scope)
- `designstudio-html`의 비주얼 편집 경험을 **서버 없이** VSCode webview 안에서 동작하게 재포팅.
- 4대 로딩 경로를 webview-안전 방식으로 통일: **sample 초기로드 / 외부 URL / 로컬 단일 파일 / 로컬 폴더**.
- 모든 미리보기 콘텐츠를 **같은-출처(`srcdoc` 또는 `about:blank` write)** 로 통일해 `contentDocument` 편집 보장.
- 외부 URL 기능을 **extension host(Node) 프록시**로 이전(`server.js`의 SSRF 방어 로직 재사용).
- 저장을 **원본 파일 in-place 갱신**(워크스페이스 파일로 연 경우) + 저장 대화상자(신규/외부 콘텐츠) 양쪽 지원.
- i18n 언어 선택을 **`globalState` 브리지**로 영속화(쿠키 폐기).
- F5 디버그 / `vsce` 패키징 / 합리적 `engines.vscode` 확립.

### 1.3 비목표 (Out of scope)
- `worker.js`(Cloudflare 엣지) 재현 — extension host는 Node이므로 `server.js` 경로만 채택.
- HTML 이외 콘텐츠(이미지/CSS/JS를 외부 URL로 직접 렌더)의 프록시 패스스루 — 1차 범위는 **HTML 문서만**.
- 캡처 북마클릿의 webview 내 실행(`javascript:` URL 비활성) — 클립보드 복사만 유지.
- 협업/실시간 동기화, 클라우드 배포, Basic 인증 게이트(host 내부 호출엔 불필요).
- vscode.dev(웹) 완전 지원 — 1차는 데스크톱 Extension Development Host 기준(웹 제약은 리스크 항목으로 명시).

---

## 2. 아키텍처

### 2.1 진입 방식: 명령 vs CustomEditor — **권고: 하이브리드(명령 + CustomTextEditorProvider 병행)**

조사결과 C #4는 명확하다: **텍스트 기반 파일(.html)을 열어 같은 파일에 저장하려면 `CustomTextEditorProvider`** 가 공식 권장이다. VSCode가 dirty 표시/Ctrl+S/백업/undo/외부변경 동기화를 대신 처리하고, 저장은 `WorkspaceEdit + workspace.applyEdit`로 한다. 단순 `command + createWebviewPanel`(기존 패턴)은 이 모든 것을 우회한다.

그러나 designstudio-html에는 **파일에 매여 있지 않은 진입 경로**(외부 URL 불러오기, 새 sample 시작, 로컬 폴더 탐색)가 존재한다. 이는 TextDocument 모델에 자연스럽게 맞지 않는다.

**권고 결정:**
- **주 진입 = `CustomTextEditorProvider`** (viewType `designstudio.htmlEditor`). `.html`/`.htm` 파일을 "Design Studio로 열기(Reopen With)"하면 그 파일이 데이터 모델이 되고, in-place 저장이 자연스럽게 동작.
- **보조 진입 = 명령 `designstudio.open`** (`createWebviewPanel`). 파일 없이 스튜디오를 띄워 외부 URL/sample/폴더를 탐색하는 "도구 창" 모드. 여기서 편집한 결과는 저장 대화상자 경로로 저장.
- 두 진입은 **동일한 webview 셸(editor.html + 어댑터)** 을 공유하고, 차이는 host 측 메시지 핸들러의 "저장 정책"과 "초기 콘텐츠 공급원"뿐.

> 사용자 결정 필요(§10): 1차 MVP를 명령 단독으로 단순화할지, 처음부터 CustomTextEditor를 포함할지.

### 2.2 Webview 패널 구성
- **단일 webview, 단일 iframe.** 미리보기 iframe은 `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`(부모가 `contentDocument` 접근하려면 `allow-same-origin` 필수 — 조사 C #1). VSCode가 띄우는 "can escape sandboxing" 경고는 통제된 콘텐츠에 대해 의도적 수용.
- `enableScripts: true`, `retainContextWhenHidden: true`(무거운 에디터; 단 메모리 비용 인지 — 가능하면 `getState/setState`로 경량화).
- `localResourceRoots`: `[media, ...workspaceFolders]`. 모든 로컬 리소스 URL은 `webview.asWebviewUri()` 경유, CSP에 `${webview.cspSource}` 참조.
- 메시지 채널(webview ↔ host)이 모든 서버 결합점의 대체 통로.

### 2.3 파일 트리 (`designstudio-html-vscode/` 하위 — 실제 생성 대상)

```
designstudio-html-vscode/
├── package.json                 # engines, contributes(command + customEditors), vsce 스크립트
├── README.md                    # 사용법(명령/Reopen With), 한계, 보안 주의
├── CHANGELOG.md
├── .vscodeignore                # node_modules 일부/문서 제외(번들 슬림)
├── .vscode/
│   └── launch.json              # F5 → Extension Development Host
├── extension.js                 # activate: 명령 등록 + CustomTextEditorProvider 등록, 메시지 라우팅
├── src/
│   ├── proxy.js                 # server.js SSRF 프록시를 {ok,html|error,contentType} 반환형으로 포팅
│   ├── editorProvider.js        # CustomTextEditorProvider 구현(resolveCustomTextEditor, applyEdit, onDidChange)
│   ├── panelController.js       # 명령형 패널(도구 창) 생성/메시지 처리
│   ├── webviewHtml.js           # editor.html 읽어 CSP + 어댑터 주입(buildHtml 일반화)
│   └── state.js                 # globalState 브리지(언어 등) read/update 헬퍼
└── media/
    ├── editor.html              # designstudio-html/index.html 포팅본(서버결합점 수정 반영)
    ├── host-adapter.js          # 로딩/저장/i18n 브리지(webview측). 가능한 범위는 무수정 어댑터
    ├── sample.html              # designstudio-html/sample.html 복사(초기 콘텐츠 문자열 공급원)
    ├── icon.svg                 # favicon.svg → 확장 아이콘으로 전용
    └── (필요시) editor-bridge.js # 어댑터로 못 덮는 로직을 위한 보조 스크립트
```

> `node_modules`는 의존성 최소화(프록시는 Node 내장 `net`/`dns`/`https`/`zlib`로 구현 가능 → 외부 런타임 의존성 0 목표). `@vscode/vsce`만 devDependency.

---

## 3. 마이그레이션 매핑 표 (서버 결합점 → webview 대체)

| # | 현재 결합점 (소스 라인 근거) | 현재 메커니즘 | webview 대체 | 수정 범위 판정 |
|---|---|---|---|---|
| 1 | **sample 초기로드** `loadSample()` `iframe.src='/sample.html'` (4401, 호출 4407) | 절대경로 `src` fetch | host가 `media/sample.html` 문자열을 부팅 시 postMessage로 공급 → webview가 `srcdoc` 주입(또는 `contentDocument.write`). `load` 미발화 대비 주입 직후 `setupIframeEvents()` 직접 호출 | **editor.html 소스 수정 필요** — `iframe.src='/sample.html'` 제거하고 메시지 수신→주입 경로로 교체 |
| 2 | **외부 URL 불러오기** `submitUrlDialog`(2477) / 재선택(2410) `iframe.src='/api/proxy?url='` | 서버 프록시 절대경로 `src` | webview가 host에 `{type:'proxy', url}` 전송 → host(`src/proxy.js`, Node SSRF 핀)가 HTML 문자열 회수 → `{ok,html\|error}` 회신 → webview가 `srcdoc`/write 주입 + `setupIframeEvents()` | **editor.html 소스 수정 필요** — `iframe.src` 제거, postMessage 요청/응답 비동기 흐름으로 교체. host는 **신규 `proxy.js`** |
| 3 | **로컬 단일 파일** `renderLocalFile`(2539-2541) `contentDocument.write` | FileReader → write | **그대로 동작 가능**(about:blank write = 같은-출처). 단 ① `<base href="/">` 주입(2536) 제거/치환 ② 파일 선택을 `<input type=file>` → host `showOpenDialog`+`workspace.fs.readFile` 경유 권장 | **부분 수정** — write 로직은 무수정 어댑터 가능. `<base>` 제거와 파일선택 host화는 **소스 수정 권장**(필수는 아님) |
| 4 | **로컬 폴더** `loadFolderFile`(2628-2630) `contentDocument.write` + CSS 인라인(2593-2601) | FileReader webkitdirectory → CSS 인라인 → write | **그대로 동작 가능**(write 같은-출처, CSS 인라인이라 절대경로 의존 없음). ① `<base href="/">`(2621) 제거/치환 ② `webkitdirectory` → host `showOpenDialog({canSelectFolders})` 권장 | **부분 수정** — write·CSS인라인은 무수정. `<base>`/폴더선택 host화는 **소스 수정 권장** |
| 5 | **iframe `load` 핸들러 + `setupIframeEvents`** (2642-2652, 2849+) | `src` 로드 시 발화 → setup | 모든 콘텐츠를 write/`srcdoc`로 통일하면 같은-출처 보장. write 경로는 `load` 미발화 → 각 로더 `setTimeout` 내 `setupIframeEvents()` 직접 호출 패턴을 sample/외부에도 적용 | **editor.html 소스 수정 필요** — sample/외부 경로에 setup 직접호출 추가(기존 로컬 패턴 재사용) |
| 6 | **저장** `downloadToBrowser(fileName,content,mime)` (saveChanges 4275 단일 호출) | Blob a.download | webview 어댑터가 `downloadToBrowser` 오버라이드 → `{type:'save', fileName, content, mime}` postMessage. host가 정책 분기(in-place applyEdit / 저장 대화상자) | **에디터 코드 무수정 어댑터로 가능** — 기존 host-adapter 패턴 그대로(단 mime 3번째 인자 전달 보강) |
| 7 | **i18n 영속** 쿠키 `ds_lang`(detectLang 1487, applyLang 1553, setCookie 1486) | `document.cookie` | `getCookie/setCookie`를 저장소 추상화로 교체 → host `globalState` 브리지(부팅 시 host가 언어 주입, 변경 시 webview→host update) | **editor.html 소스 수정 필요(소폭)** — `detectLang/applyLang`의 쿠키 I/O를 추상화 함수로. 또는 어댑터가 `document.cookie` shim + globalState 동기화로 부분 회피 가능 |
| 8 | `<link rel="icon" href="/favicon.svg">` (8) | 절대경로 파비콘 | 제거 또는 `asWebviewUri`로 치환(무해, 404만 방지) | **소스 수정 권장(경미)** |
| 9 | Google Fonts / Unsplash / cdn.jsdelivr | 외부 로드 | CSP가 이미 커버(style-src googleapis, font-src gstatic, img-src https:, script-src cdn.jsdelivr). 결합점 아님 | **무수정** |
| 10 | 캡처 북마클릿 `buildCaptureBookmarklet`(2484) `javascript:` href(4409) | 외부 탭 실행 | webview에서 `javascript:` href 비활성 가능 → `copyBookmarkletCode`(클립보드)만 신뢰. 캡처 결과 `.html`은 #3 경로로 재진입 | **소스 수정 권장(경미)** — href 바인딩 대신 복사 버튼만 노출 |

**요약 판정:** 같은-출처 편집의 핵심 두 경로(로컬 파일/폴더 write)는 webview에서 그대로 살아있다. **소스 수정이 불가피한 것은 sample·외부 URL의 `src` 제거 + setup 직접호출 + `<base>` 제거 + i18n 추상화**다. 저장은 무수정 어댑터로 충분하다.

---

## 4. iframe 같은-출처 전략

### 4.1 왜 `srcdoc`(또는 about:blank write)가 필수인가
- 에디터의 본질은 `setupIframeEvents`가 iframe `contentDocument`에 **스타일 주입 + 이벤트 리스너 부착**, 그리고 편집·저장 시 `contentDocument` 직렬화다. 이는 **같은-출처에서만** 가능(조사 C #1).
- `iframe.src='/sample.html'`/`'/api/proxy?...'`는 webview에서 `vscode-webview://<uuid>/...` 절대경로로 해석되어 서버 부재로 **로드 실패**하거나, 설령 로드돼도 부모와 다른 출처가 되어 `contentDocument`가 막힌다(조사 A).
- **`about:blank`로 출발한 iframe에 `contentDocument.write`**(현 로컬/폴더 경로) 또는 **`iframe.srcdoc=html` 설정 후 `load` 이벤트에서 `contentDocument` 접근**은 부모와 같은-출처를 유지한다.

**권고:** 모든 콘텐츠 공급을 두 방식 중 하나로 통일. `srcdoc`는 선언적이고 `load` 이벤트가 정상 발화(조사 C: "load를 레이스하지 말고 load 이벤트 후 contentDocument 접근")해 setup 타이밍이 깔끔하다. 단 기존 로컬/폴더가 이미 `contentDocument.write`로 동작하므로, **전 경로를 write 방식으로 통일**해 setup 호출 패턴(`setTimeout` 또는 즉시)을 단일화하는 것도 일관성 측면에서 유효하다. → **1차 권고: write 방식 통일**(코드 변경 최소, 기존 setup 패턴 재사용). srcdoc는 외부 URL 콘텐츠 격리가 필요할 때 옵션.

### 4.2 sandbox 속성
미리보기 iframe: `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`.
`allow-scripts` + `allow-same-origin` 조합은 VSCode가 경고하지만, 부모가 `contentDocument`를 조작해야 하는 에디터에는 필수·수용(조사 C #1). 외부 URL(신뢰 불가 HTML)을 같은 iframe에 `allow-same-origin`으로 넣는 것은 격리 약화이므로 §10 결정 항목.

### 4.3 CSP 구체안 (현 소스 기준 조정)
기존 `extension.js` CSP를 기준으로 다음과 같이 조정:

```
default-src 'none';
img-src ${cspSource} https: data: blob:;
media-src ${cspSource} blob: data:;
style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com;
font-src ${cspSource} https://fonts.gstatic.com data:;
script-src 'unsafe-inline' 'unsafe-eval' ${cspSource} https://cdn.jsdelivr.net;
connect-src ${cspSource} https: data: blob:;
frame-src 'self' data: blob:;
```

조정 근거:
- **`script-src 'unsafe-inline' 'unsafe-eval'` 유지(필수).** index.html은 다수 인라인 `onclick/oninput` 핸들러 기반 SPA. nonce는 인라인 이벤트 핸들러를 인가하지 못함(`unsafe-hashes` 없이는 — 조사 C #2). 이는 허용되는 보안 완화이며 장기 리팩터(addEventListener + nonce) 대상으로 문서화. nonce를 같은 디렉티브에 넣으면 `unsafe-inline`이 무시되므로 **혼용 금지**.
- **`connect-src`**: 외부 URL 콘텐츠(`<base href=원본>`)의 상대경로 리소스가 webview 안에서 원본 서버로 직접 나갈 수 있어 `https:` 유지. host fetch는 CSP 무관(Node에서 나감)이지만 srcdoc 콘텐츠 내 fetch 대비 `https:` 허용.
- **`frame-src`**: 기존 `*`는 과도. 모든 콘텐츠를 `srcdoc`/write로 공급하면 외부 도메인을 직접 framing하지 않으므로 **`'self' data: blob:`로 강화** 가능(조사 C 사전 이슈 권고). 만약 외부 URL을 `srcdoc` 대신 직접 frame하는 폴백을 둔다면 그때만 완화.

---

## 5. 외부 URL 기능: host 프록시 재구현 권고

### 5.1 권고: **`server.js` SSRF 경로를 거의 동등하게 재사용** (축소 아님)
조사 B 결론: extension host(Node 24)에서 **전역 `fetch`만 쓰면 worker.js 수준으로 떨어져 위험**(DNS 리바인딩/내부망 도달 방어 불가). Node는 사내망·169.254.169.254 메타데이터에 실제 도달 가능하므로 worker.js의 "엣지는 공용 인터넷에서만 나간다" 전제가 성립하지 않는다. **반드시 `server.js`의 `net`/`dns` 기반 IP 핀 경로(`resolveAndPin` + `requestPinned`)를 채택**한다.

### 5.2 재사용 대상(거의 그대로 이식 → `src/proxy.js`)
- 스킴 화이트리스트(http/https), `dns.lookup(all:true)` IP 핀, DNS 리바인딩 차단(검증한 IP로만 연결, `lookup` 콜백 오버라이드), SNI/Host 보존, 사설/루프백/링크로컬/메타데이터/CGNAT/멀티캐스트 대역 차단, IPv6(`::1`,`fe80`,`fc/fd`, `::ffff:` 매핑 재검사), 리다이렉트 5회 한계 + 매 홉 재검증, 응답 크기 상한 25MB(zip bomb 방지), 타임아웃 15s, 압축 해제(gzip/deflate/br), charset 디코드(utf-8 폴백), **`<base href=절대 targetUrl>` 주입(필수)**, `X-Content-Type-Options: nosniff` 상응 처리.

### 5.3 필수 변경
1. **HTTP 응답 → 값 반환.** `res.writeHead/end` 제거, `handleProxy`가 `{ok, html|error, contentType, status}` 객체 반환 → host가 `panel.webview.postMessage({type:'proxyResult', ...})`.
2. **Basic 인증 게이트(`checkAuth`) 제거** — host 내부 호출엔 불필요.
3. **`<base>` 주입 실패 시 정책 재고** — 현 server.js는 실패해도 원본 패스스루(console.error). srcdoc/write 컨텍스트에선 상대경로가 webview로 잘못 해석될 수 있으므로 **실패 시 에러 처리로 전환 검토**(조사 B 약점 (b)).
4. **비HTML 콘텐츠**: srcdoc로 못 보냄 → 1차는 "HTML만 지원"으로 범위 한정(에러 또는 안내). 이미지 등은 향후 `data:`/webview 리소스.
5. 에러 포맷은 server.js의 한국어 502 에러 HTML을 그대로 `error` 필드 문자열로 반환해 webview가 iframe에 표시 가능.

### 5.4 동등성 판정
**완전 동등(축소 아님)** 으로 권고. 프록시는 보안 경계이므로 약화하면 SSRF 노출. 단 "비HTML 패스스루"와 "Basic 인증"만 범위에서 제외(전자는 기능 축소, 후자는 불필요).

---

## 6. 저장 전략

### 6.1 두 가지 저장 정책 (진입 모드별 분기)
host의 `save` 핸들러가 콘텐츠 출처를 알고 분기:

| 진입/콘텐츠 출처 | 저장 동작 |
|---|---|
| **CustomTextEditor로 연 워크스페이스 `.html`** | **원본 in-place 갱신**: `WorkspaceEdit`로 문서 전체 치환 → `workspace.applyEdit`. Ctrl+S/dirty/undo/백업이 VSCode 기본동작으로 통합(조사 C #4). raw `fs.writeFile` 금지. |
| **명령(도구 창) / 외부 URL·sample에서 시작 / "다른 이름으로"** | **저장 대화상자**: `showSaveDialog` → `workspace.fs.writeFile`(기존 extension.js 패턴 재사용). |

### 6.2 원본 덮어쓰기 옵션
- CustomTextEditor 모드에서 사용자가 "다른 이름으로 저장"을 원하면 대화상자 경로로 빠지는 보조 명령/버튼 제공.
- 외부 URL을 불러와 편집한 경우 원본이 없으므로 항상 대화상자(워크스페이스에 신규 파일).
- **사용자 결정 필요(§10)**: 기본 동작을 "원본 덮어쓰기"로 할지 "항상 대화상자"로 할지.

### 6.3 downloadToBrowser 후킹
- webview 어댑터가 `window.downloadToBrowser = (fileName, content, mime) => postMessage({type:'save', fileName, content, mime})`로 오버라이드(기존 패턴, **mime 3번째 인자 보강**).
- 어댑터는 editor.html **본문 스크립트 뒤(`</body>` 직전)** 주입해 오버라이드가 이김(기존 buildHtml 규칙 유지).
- host `saved` 회신 → webview `showToast`.
- 무한 갱신 루프 방어(조사 C #4): CustomTextEditor에서 `onDidChangeTextDocument` 구독 시, **webview 자신이 유발한 편집은 재렌더 스킵**(편집 출처 플래그/비교).

---

## 7. i18n 지속성

### 7.1 문제
현 i18n는 순수 클라이언트(`ds_lang` 쿠키, path=/, max-age=1년, samesite=lax). webview는 출처(`vscode-webview://<uuid>`)가 세션마다 회전하고 백그라운드 시 콘텐츠가 파괴되어 **쿠키/localStorage 영속이 보장되지 않음**(조사 C #3). `getCookie` null이면 `navigator.language` 폴백이라 깨지진 않으나 **사용자 선택이 기억 안 됨**.

### 7.2 권고: **globalState 브리지** (주) + getState/setState(보조 캐시)
- **영속 진실원 = `context.globalState`**(머신 전역, 세션 간 영속; cross-machine 원하면 `setKeysForSync` 추가).
- 흐름: 패널/에디터 열릴 때 host가 `globalState.get('ds_lang')`를 읽어 webview에 주입(초기 메시지 또는 buildHtml에 인라인). 사용자가 언어 변경 → webview `postMessage({type:'setLang', lang})` → host `globalState.update('ds_lang', lang)`.
- **세션 내 UI 캐시 = `getState/setState`**(백그라운드↔복귀 시 즉시 복원), globalState 위에 얹는 보조 계층.
- editor.html의 `detectLang/applyLang`의 `getCookie/setCookie`를 **저장소 추상화 함수**로 교체(예: `readLang()/writeLang()` — 내부적으로 host 메시지). 또는 어댑터가 `document.cookie` getter/setter를 shim해 globalState와 동기화하는 부분-무수정 방식도 가능(소스 수정 최소화 트레이드오프).
- **쿠키 경로는 폐기**(samesite=lax는 webview 내비 모델과도 충돌 소지).

---

## 8. 패키징 / 실행

- **패키징 도구**: `@vscode/vsce`(devDep `^3.x`). `npm i -g @vscode/vsce` 또는 npx, `vsce package` → `.vsix`. 스크립트 `package`/`publish` 유지.
- **`engines.vscode`**: 실제 사용 API의 최저 버전으로 설정. `CustomTextEditorProvider`는 오래 안정된 API이므로 광범위 설치를 위해 기존 `^1.85.0` 유지 가능(또는 더 낮춤). CI/테스트 VSCode 버전 이하로 유지(조사 C #5).
- **F5 실행**: `.vscode/launch.json`으로 Extension Development Host 기동. 명령(`designstudio.open`)과 "Reopen With → Design Studio"를 호스트에서 검증. 패키징 전 반드시 F5 검증(특히 vscode.dev 웹은 CSP/CORS 더 엄격 — 데스크톱 우선).
- **`contributes`**: `commands`(`designstudio.open`) + `customEditors`(viewType `designstudio.htmlEditor`, selector `*.html`/`*.htm`, priority `option` — 기본 텍스트 에디터를 뺏지 않도록 "다시 열기" 방식).
- **리소스 규칙**: `localResourceRoots`=[media, ...workspaceFolders], 모든 로컬 URL `asWebviewUri`, CSP에 `${cspSource}`, `enableScripts:true`. `retainContextWhenHidden:true`는 메모리 비용 인지.
- **`.vscodeignore`**: node_modules 불필요분/문서 제외해 vsix 슬림.

---

## 9. 단계별 구현 계획 (Phase) + 산출물

### Phase 0 — 골격 / 스캐폴드
- `designstudio-html-vscode/` 생성, `package.json`(engines/contributes/scripts), `.vscode/launch.json`, `.vscodeignore`.
- `media/`에 `index.html`→`editor.html`, `sample.html`, `favicon.svg`→`icon.svg` 복사.
- **산출물**: F5로 빈/정적 editor.html이 명령으로 뜨는 것 확인(아직 서버결합점 미해결, sample 로드는 깨진 상태 OK).

### Phase 1 — 같은-출처 로딩 통일 (sample + 로컬 파일/폴더)
- editor.html 수정: `loadSample`의 `iframe.src='/sample.html'` 제거 → host가 공급한 sample 문자열 write 주입 + `setupIframeEvents` 직접 호출.
- 로컬 파일/폴더: write 경로는 유지, `<base href="/">` 제거/치환. 파일/폴더 선택을 host `showOpenDialog` + `workspace.fs.readFile`로 이전(어댑터 메시지).
- `media/host-adapter.js`에 로딩 브리지 추가, `src/webviewHtml.js`로 buildHtml 일반화(CSP §4.3 적용).
- **산출물**: sample/로컬파일/로컬폴더 3경로가 webview에서 같은-출처 편집 정상. 클릭 선택·스타일 주입 동작 확인.

### Phase 2 — 저장 (in-place + 대화상자)
- 어댑터 `downloadToBrowser` 오버라이드(mime 보강) → host `save` 핸들러.
- 명령(도구 창) 모드: `showSaveDialog`+`workspace.fs.writeFile`.
- **산출물**: 편집 결과를 디스크에 저장. 토스트 회신.

### Phase 3 — CustomTextEditorProvider (in-place 편집)
- `src/editorProvider.js`: `resolveCustomTextEditor`에서 문서 텍스트를 초기 콘텐츠로 주입, 저장은 `WorkspaceEdit + applyEdit`, `onDidChangeTextDocument` 구독 + 갱신 루프 방어.
- `customEditors` 기여 등록. "Reopen With → Design Studio".
- **산출물**: 워크스페이스 `.html`을 열어 시각 편집 → Ctrl+S로 원본 in-place 저장, dirty/undo/외부변경 동기화 동작.

### Phase 4 — 외부 URL host 프록시
- `src/proxy.js`: server.js SSRF 경로 이식(§5), 값 반환형.
- editor.html: `submitUrlDialog`/재선택의 `iframe.src='/api/proxy...'` 제거 → `{type:'proxy',url}` 요청/`proxyResult` 응답 비동기 흐름 + 주입 + setup.
- **산출물**: 외부 URL을 안전 프록시로 불러와 같은-출처 편집. SSRF 차단(사설/메타데이터/리바인딩) 검증.

### Phase 5 — i18n globalState 브리지
- `src/state.js` + 어댑터/editor.html i18n 추상화. 쿠키 폐기.
- **산출물**: 언어 선택이 세션·재시작 간 영속.

### Phase 6 — 마감 (CSP 강화 / 정리 / 패키징)
- `frame-src` 강화, 파비콘/북마클릿 href 정리, README/CHANGELOG, `vsce package` → `.vsix`.
- **산출물**: 설치 가능한 `.vsix`, 문서 완비.

---

## 10. 리스크 / 오픈 이슈 + 사용자 결정 항목

### 10.1 리스크 / 오픈 이슈
- **R1 인라인 핸들러 CSP 완화**: `unsafe-inline`/`unsafe-eval` 유지 불가피(인라인 onclick SPA). 보안 완화 문서화 + 장기 addEventListener+nonce 리팩터 백로그.
- **R2 allow-same-origin 격리 약화**: 외부 URL(신뢰 불가)을 부모 접근 가능한 iframe에 넣음. 격리와 편집기능의 트레이드오프. 외부 콘텐츠 전용 sandbox 분리 가능성 검토(편집 비활성 미리보기 모드).
- **R3 프록시 약점**: charset utf-8 폴백만(EUC-KR/Shift_JIS 깨질 수 있음), 비HTML 미지원, `<base>` 주입 실패 처리, 상대경로 리소스가 webview에서 원본으로 직접 나감(CSP `connect-src https:` 의존).
- **R4 vscode.dev(웹)**: 더 엄격한 CSP/CORS로 iframe·프록시 동작 제약. 1차 데스크톱 한정.
- **R5 갱신 루프**: CustomTextEditor `onDidChangeTextDocument` ↔ webview 재렌더 루프(조사 C #4 명시 경고) — 편집 출처 플래그 필수.
- **R6 메모리**: `retainContextWhenHidden:true` + 거대 SPA = 고메모리. getState/setState 경량화 검토.
- **R7 의존성**: 프록시를 Node 내장으로 구현해 런타임 의존성 0 목표(번들 안정성↑).

### 10.2 사용자에게 물어야 할 결정 (2~3개)
1. **외부 URL 프록시 재구현 범위**: server.js SSRF 경로를 **완전 동등**으로 이식(권고, 보안 유지·구현비용↑) vs **축소**(전역 fetch + 도메인 차단만, SSRF 위험↑). → 권고: 완전 동등.
2. **저장 기본 동작**: 워크스페이스 파일을 열었을 때 **원본 덮어쓰기(in-place, Ctrl+S 통합)** vs **항상 저장 대화상자**. → 권고: in-place 기본 + "다른 이름으로" 보조.
3. **진입 방식 1차 범위**: **명령 단독 MVP**(빠름, in-place 미흡) vs **처음부터 CustomTextEditor 포함**(권고, in-place 저장 정공법, 구현비용↑). → 권고: Phase 3까지 포함하되 MVP 데모는 Phase 2까지.
