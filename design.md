# Hikoutei website design system

상태: **design baseline**  
기준일: **2026-09-01**  
참조: [Stripe homepage](https://stripe.com/)

이 문서는 Hikoutei의 마케팅 페이지와 live reliability demo가 공유할 시각
규칙이다. Stripe의 현재 홈페이지에서 확인한 토큰·비율·정보 밀도를 참고하되,
브랜드, 콘텐츠, 코드, 자산을 복제하지 않는다.

## 1. 디자인 방향

Stripe에서 가져올 것은 "보기에 화려한 결제 서비스"가 아니라 다음 원칙이다.

- 큰 여백과 단정한 12-column grid로 복잡한 기술 정보를 정리한다.
- 밝은 background와 깊은 navy text를 기본으로 하고, 한 개의 선명한 brand
  color만 행동 유도에 사용한다.
- 제목은 가볍고 크게, 본문·nav·버튼은 읽기 쉬운 보통 굵기로 쓴다.
- border, shadow, radius는 존재감보다 구조를 구분하는 용도로만 사용한다.
- reliability 상태는 purple이 아니라 semantic color로 구분한다. 성공은 green,
  주의는 amber, 실패는 red다.

Hikoutei의 제품 메시지는 **"SQLite가 authority이고 Google Sheets는 비동기
projection"** 이다. 따라서 화면은 database, outbox, worker, projection의
경계를 선명하게 보여야 하며, Sheets를 source of truth처럼 표현하면 안 된다.

## 2. 색상

### 2.1 Foundation

아래 값은 Stripe에서 확인한 core/action token을 Hikoutei 용도로 이름만
재정리한 것이다.

| Token | Value | 용도 |
| --- | --- | --- |
| `--color-ink` | `#061B31` | 기본 heading, 고대비 text |
| `--color-ink-raised` | `#0D253D` | dark surface, footer, deep text |
| `--color-text` | `#273951` | 본문, navigation |
| `--color-text-muted` | `#50617A` | 보조 설명, metadata |
| `--color-text-placeholder` | `#7D8BA4` | disabled/placeholder |
| `--color-surface` | `#FFFFFF` | 기본 page/card surface |
| `--color-surface-quiet` | `#F8FAFD` | section 배경, subtle card |
| `--color-border` | `#E5EDF5` | 기본 divider/card border |
| `--color-border-strong` | `#A8C3DE` | 강조된 outline |
| `--color-brand` | `#533AFD` | primary CTA, active state |
| `--color-brand-hover` | `#4032C8` | primary CTA hover |
| `--color-brand-soft` | `#E2E4FF` | selected/subdued background |
| `--color-brand-tint` | `#F5F5FF` | very quiet brand surface |

### 2.2 Semantic status

| Token | Value | 적용 예 |
| --- | --- | --- |
| `--color-success` | `#00B261` | worker healthy, projection delivered |
| `--color-warning` | `#F9B900` | queue backlog, retry pending |
| `--color-danger` | `#D8351E` | failed effect, conflict/error |
| `--color-info` | `#665EFD` | processing, selected filter |
| `--color-magenta` | `#EA2261` | 보조 데이터 series |
| `--color-orange` | `#FF6118` | 보조 데이터 series 또는 warning 강조 |

### 2.3 Dark observability surface

live demo처럼 telemetry를 집중해서 보는 표면에서는 다음을 사용한다.

```css
:root {
  --demo-bg: #0d1738;
  --demo-surface: #11273e;
  --demo-surface-raised: #273951;
  --demo-text: #ffffff;
  --demo-text-muted: #bac8da;
  --demo-grid: rgb(168 195 222 / 18%);
  --demo-brand: #7f7dfc;
  --demo-success: #00b261;
}
```

Dark mode에서도 성공 상태를 purple로 바꾸지 않는다. `success`, `warning`,
`danger`는 항상 의미가 같아야 한다.

## 3. 타이포그래피

Stripe 페이지에서 확인한 font family는 `sohne-var, "SF Pro Display",
sans-serif`다. Söhne는 이 프로젝트에 포함하거나 웹폰트로 가져오지 않는다.
Hikoutei는 이미 로드하는 **Inter**를 product sans로 사용한다.

```css
--font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono: "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
```

### 3.1 Heading scale

Stripe의 heading token은 300 weight, 약한 negative letter-spacing, 짧은
line-height를 공통으로 쓴다. Hikoutei도 이 비율을 따른다.

| 역할 | Size | Line-height | Weight | Letter-spacing | 사용처 |
| --- | ---: | ---: | ---: | ---: | --- |
| Display / XXL | `56px` | `1.03` | `300` | `-0.025em` | 페이지 hero, 큰 statement |
| XL | `48px` | `1.03` | `300` | `-0.02em` | section hero |
| L | `32px` | `1.10` | `300` | `-0.02em` | 주요 section title |
| M | `26px` | `1.12` | `300` | `-0.01em` | panel/feature title |
| S | `22px` | `1.10` | `300` | `-0.01em` | card title |
| XS | `16px` | `1.20` | `400` | `0` | compact heading |

화면 폭이 좁을 때 Display는 `clamp(40px, 5vw, 56px)`로 줄인다. 제목을 굵게
만들어 힘을 주지 말고, 크기·여백·대비로 hierarchy를 만든다.

### 3.2 Text scale

| 역할 | Size | Line-height | Weight | 사용처 |
| --- | ---: | ---: | ---: | --- |
| Body XL | `20px` | `1.4` | `300–400` | hero description |
| Body L | `18px` | `1.4` | `300–400` | feature description |
| Body | `16px` | `1.4–1.5` | `400` | 기본 문장 |
| Small | `14px` | `1.4` | `400` | navigation, helper text |
| Micro | `12px` | `1.45` | `400–500` | labels, metadata |
| Metric | `12px` | `1.2` | `500` | mono + uppercase telemetry label |

Telemetry value와 id는 `--font-mono`를 사용한다. 예: `24.8 jobs/s`,
`effect_8f21`, `847ms`. 일반 설명 문장까지 mono로 쓰지 않는다.

## 4. Layout과 spacing

Stripe의 현재 layout token은 **12 columns / 1264px max width / 16px outer
margin / 16px column gap**이다. Hikoutei 웹사이트의 기본 grid도 이를 따른다.

```css
--layout-max: 1264px;
--layout-columns: 12;
--layout-margin: 16px;
--layout-gap: 16px;
```

### 4.1 Spacing scale

기본 단위는 4px이지만 layout은 주로 아래 값만 사용한다.

| Token | Value | 적용 |
| --- | ---: | --- |
| `--space-1` | `8px` | inline icon gap |
| `--space-2` | `12px` | compact control gap |
| `--space-3` | `16px` | grid gap, default padding |
| `--space-4` | `24px` | card padding, CTA horizontal padding |
| `--space-5` | `32px` | component separation |
| `--space-6` | `48px` | small section gap |
| `--space-7` | `64px` | subsection gap |
| `--space-8` | `80px` | desktop content breathing room |
| `--space-9` | `96px` | standard section top/bottom gap |
| `--space-10` | `128px` | large marketing transition |

Mobile은 page margin을 `20–24px`로 두고, section gap은 `48–64px`로 축소한다.

## 5. Shape, border, shadow

| Token | Value | 사용처 |
| --- | ---: | --- |
| `--radius-xs` | `2px` | tiny state indicator |
| `--radius-sm` | `4px` | button, input, tag |
| `--radius-md` | `6px` | card, menu, chart shell |
| `--radius-lg` | `16px` | hero graphic, large product block |
| `--radius-xl` | `32px` | rare showcase surface only |

- 기본 card: `1px solid var(--color-border)`, `6px` radius, shadow 없음.
- hover card: border만 `--color-border-strong`으로 올리거나 아주 약한 shadow를
  추가한다.
- primary button: `4px` radius, `16px` text, `16px 24px` padding, white text.
- secondary button: transparent background, `#D6D9FC` border, brand text.

## 6. Component rules

### Navigation

- 14px text, 400 weight, light surface 위 deep ink text.
- Navigation은 content를 설명하는 도구다. demo의 status는 nav에 넣지 않는다.
- primary CTA는 한 화면에 하나만 `--color-brand` solid로 둔다.

### Hero

- eyebrow → large heading → 1–2줄 description → CTA 순서를 고정한다.
- hero paragraph의 max width는 `560–640px`.
- hero의 장식 gradient는 text 대비를 낮추지 않는 범위에서만 사용한다.

### Card와 panel

- 한 card에는 하나의 핵심 질문만 답한다. 예: "queue depth는 안전한가?"
- panel heading에는 label, title, 현재 상태 또는 value를 둔다.
- dashboard row의 card padding은 `24px`, desktop grid gap은 `16px`.
- border보다 색상 block을 먼저 사용하지 않는다. quiet surface + thin border를
  기본으로 한다.

### Chart와 reliability state

- chart의 primary series는 `--color-brand` 또는 `--color-info` 하나만 쓴다.
- 성공/경고/실패는 chart series가 아니라 event/state badge에서 semantic color로
  표현한다.
- 전체 시스템 healthy는 "초록색 화면"이 아니라 calm surface + 작은 success
  indicator로 보여 준다.
- queue, outbox, worker, Sheets projection은 각각 다른 책임이므로 하나의
  "database status"로 합치지 않는다.

## 7. Accessibility rules

- body text와 surface의 contrast는 최소 WCAG AA를 충족한다.
- 상태를 색상만으로 전달하지 않는다. `Healthy`, `Retrying`, `Failed` 같은 text를
  항상 함께 둔다.
- focus ring은 `--color-brand`를 2px 이상으로 표시한다.
- animation은 status 변화를 보조할 뿐, 완료/실패 판단에 필수여서는 안 된다.
- `prefers-reduced-motion`에서는 chart entrance animation과 decorative motion을
  줄이거나 끈다.

## 8. Implementation handoff

새 UI를 만들 때는 먼저 이 순서로 판단한다.

1. light marketing surface인지, dark observability surface인지 정한다.
2. heading/text/metric 중 어떤 typography role인지 고른다.
3. spacing scale에서만 margin과 padding을 선택한다.
4. primary action은 brand color 하나만 사용한다.
5. 상태 정보는 semantic token과 text label을 함께 사용한다.

현재 `/demo`는 dark observability surface다. 이후 data source가 연결되더라도
이 문서의 semantic status와 typography hierarchy를 유지한다.

## 9. Reference evidence

Stripe homepage를 2026-09-01에 확인한 기준값:

- font family: `sohne-var, "SF Pro Display", sans-serif`
- primary button: `#533AFD`, `4px` radius, 16px text, horizontal padding 24px
- heading token: XXL 56px / 1.03 / 300 / -0.025em, XL 48px / 1.03 / 300
- text token: 16px / 1.4 / 300, small text 14px
- layout token: 12 columns, max width 1264px, margin/gap 16px
- section gap: 96px; compact section gap: 48px

원본 페이지는 계속 바뀔 수 있으므로, 이후 Stripe를 다시 참고할 때는 이 문서를
무비판적으로 덮어쓰지 말고 Hikoutei의 SQLite-authoritative product boundary와
맞는지 먼저 검토한다.
