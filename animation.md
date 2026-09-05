# React Native Animation Collection

React Native 애니메이션 예제 모음(`/Users/choeyeongho/Library/Mobile Documents/com~apple~CloudDocs/react native animation`)을 소스 기준으로 정리한 문서다.

## 조사 범위

- 독립 프로젝트: 103개
- TypeScript/JavaScript 소스: 1,093개
- JSON 설정 파일: 315개
- README: 14개
- 사용한 핵심 구현: `react-native-reanimated`, `react-native-gesture-handler`, `@shopify/react-native-skia`, React Native `Animated`, Lottie, Moti, Expo Haptics
- 이미지·폰트·아이콘 등 바이너리 asset과 lock 파일은 애니메이션 동작을 설명하는 데 직접적인 정보가 없어 개별 항목에서는 생략했다.

각 프로젝트는 서로 독립된 Expo 앱이다. 따라서 이 문서의 버전 정보는 하나의 통합 앱에 맞춘 설치 안내가 아니라, 원본 프로젝트가 사용하는 기술 조합을 기록한 것이다.

## 전체적인 결론

이 컬렉션의 중심 패턴은 다음과 같다.

1. 제스처 또는 스크롤 이벤트를 Reanimated shared value에 기록한다.
2. `useDerivedValue`와 `interpolate`로 화면에 필요한 중간 값을 만든다.
3. `useAnimatedStyle` 또는 Skia의 `Canvas`/`Path`/`Shader`에 그 값을 연결한다.
4. 손을 뗐을 때 `withSpring`, `withTiming`, `withDecay` 중 상호작용에 맞는 감속 방식을 적용한다.
5. JS 상태 변경, 네비게이션, 햅틱처럼 JS에서 실행해야 하는 작업은 `runOnJS`로 경계를 넘긴다.

### 사용 빈도

| 기술/패턴 | 프로젝트 수 | 주된 역할 |
| --- | ---: | --- |
| React Native Reanimated | 95 | shared value, UI thread 스타일 계산, spring/timing |
| React Native Gesture Handler | 77 | pan, tap, long press, fling 제스처 |
| React Native Skia | 62 | Canvas, Path, blur/mask, shader, custom drawing |
| `useAnimatedStyle` | 87 | transform, opacity, 색상, 크기 적용 |
| `useSharedValue` | 85 | 제스처·스크롤·애니메이션 상태 저장 |
| `useDerivedValue` | 79 | 파생 geometry, progress, 표시 값 계산 |
| `withTiming` | 72 | 일정 시간의 전환·fade·progress |
| `interpolate` | 70 | progress를 위치·크기·색상·회전으로 변환 |
| `withSpring` | 48 | 손을 뗀 뒤 복귀, 버튼 반응, sheet snap |
| `runOnJS` | 53 | UI worklet에서 callback·햅틱·상태 업데이트 호출 |
| `useAnimatedReaction` | 28 | UI 값 변화 감시 및 JS callback 연결 |
| `useAnimatedScrollHandler` | 15 | 스크롤 위치를 UI thread에서 직접 수집 |
| `Canvas` | 55 | Skia 기반 그래픽 렌더링 |
| `RuntimeEffect` | 7 | GLSL/SkSL fragment shader |
| `Gesture.Pan()` | 33 | 드래그·슬라이더·sheet·카드 이동 |
| `Gesture.Tap()` | 43 | 버튼·선택·토글·press feedback |
| entering/exiting/layout transition | 27 전후 | 목록·텍스트·모달의 mount/unmount/layout 변화 |

### 의존성 세대가 섞여 있음

원본은 Expo SDK 47~52, React Native 0.70~0.76, Reanimated 2.12~3.16, Skia 0.1.x~1.5.x가 섞여 있다. Reanimated 2 계열 예제는 `Extrapolate.CLAMP` 같은 이전 API를 사용하고, 3 계열 예제에는 `Extrapolation.CLAMP`가 보인다. 한 앱으로 합칠 때는 예제 코드를 그대로 복사하기보다 설치된 Expo·Reanimated·Skia 버전에 맞춰 API를 확인해야 한다.

## 핵심 구현 패턴

### 1. UI thread 상태와 React state의 분리

드래그 중 매 프레임 바뀌는 값은 React state가 아니라 shared value에 둔다.

```tsx
const translateX = useSharedValue(0);
const contextX = useSharedValue(0);

const gesture = Gesture.Pan()
  .onStart(() => {
    contextX.value = translateX.value;
  })
  .onUpdate(event => {
    translateX.value = contextX.value + event.translationX;
  })
  .onEnd(() => {
    translateX.value = withSpring(0);
  });
```

`contextX`처럼 gesture 시작 시점을 저장하면 현재 위치에서 자연스럽게 이어서 움직일 수 있다. `withSpring`은 손을 뗀 뒤의 복귀·snap에, `withDecay`는 관성 스크롤에, `withTiming`은 명확한 시작·종료 시간이 필요한 상태 전환에 적합하다.

### 2. progress 하나로 여러 속성 제어

bottom sheet, modal, tab indicator, 버튼 morph처럼 여러 속성이 함께 바뀌는 UI는 `progress: 0..1`을 중심으로 만든다.

```tsx
const rStyle = useAnimatedStyle(() => ({
  height: interpolate(progress.value, [0, 1], [MIN_HEIGHT, screenHeight]),
  borderRadius: interpolate(progress.value, [0, 1], [20, 0]),
  opacity: interpolate(progress.value, [0, 0.2, 1], [0, 0, 1]),
}));
```

이 방식은 위치뿐 아니라 `interpolateColor`, `pointerEvents`, z-index, 텍스트 opacity까지 한 상태로 동기화할 수 있다. `add-to-cart`, `floating-modal`, `expandable-mini-player`, `stacked-bottom-sheet`가 대표적인 사용 예다.

### 3. 입력 범위와 출력 범위의 설계

스크롤 기반 UI는 아이템의 중심을 기준으로 여러 구간을 만든다. `3d-scroll-transition`과 `blurred-scroll`은 같은 아이템에 대해 opacity, rotateX, blur를 각각 다른 output range로 계산한다.

```tsx
const inputRange = [
  size * (index - 1),
  size * (index - 1) + 20,
  size * index,
  size * (index + 1) - 20,
  size * (index + 1),
];

const opacity = interpolate(scrollY.value, inputRange, [0, 0.5, 1, 0.5, 0]);
```

비싼 blur를 중앙 아이템에서만 0으로 만드는 식의 구간 설계는 시각 효과와 성능을 함께 조절하는 방법이다. 입력 범위 바깥 동작은 `Extrapolation.CLAMP`로 제한하는 편이 안전하다.

### 4. press feedback을 공통 컴포넌트로 추출

`action-tray`, `add-to-cart`, `tab-navigation`, `gl-transitions`, `interaction-appearance` 등은 비슷한 `PressableScale`을 각각 갖고 있다. 보통 touch down에서 0.90~0.95로 축소하고 finalize에서 1로 되돌린다.

```tsx
const scale = useSharedValue(1);

const tap = Gesture.Tap()
  .onTouchesDown(() => {
    scale.value = withTiming(0.92);
  })
  .onTouchesUp(() => {
    runOnJS(onPress)();
  })
  .onFinalize(() => {
    scale.value = withTiming(1);
  });
```

프로젝트에 따라 `withSpring`과 `overshootClamping`을 사용해 더 단단한 느낌을 주거나, callback을 spring 완료 후 실행한다.

### 5. Layout/entering/exiting transition

목록 항목이 추가·삭제되거나 숫자 자릿수가 바뀌는 경우 `layout={Layout}`, `entering={FadeIn}`, `exiting={FadeOut}`을 사용한다. `animated-count-text`, `animated-grid-list`, `composable-text`, `loading-button`, `sudoku`가 이 패턴을 사용한다.

Layout transition은 위치·크기 재계산을 자동화하지만, mount/unmount 순서와 key가 중요하다. `animated-count-text`는 숫자를 자릿수별 컴포넌트로 분리하고 각 컴포넌트 안에서 0~9 세로 wheel을 움직여 자릿수 변경을 표현한다.

### 6. Skia로 일반 View의 한계를 넘기

Skia 예제는 크게 네 종류다.

- `Canvas` + `Path`: 곡선, 차트, custom icon, 도형, crop overlay
- `Blur` + `Mask`/`BlurMask`: 유리 효과, gooey effect, masked text, reveal
- `RuntimeEffect` + `Shader`: card reflection, Fibonacci/fractal, GL transition
- `makeImageFromView` + `ImageShader`/clip path: 화면 snapshot 기반 전환

Skia 값과 Reanimated shared value를 연결할 때는 `useDerivedValue`를 사용한다. Path를 매 프레임 새로 만들거나 blur를 넓은 영역에 적용하면 비용이 커지므로, 필요한 영역만 그리거나 불필요한 프레임의 blur를 0으로 만드는 전략이 유용하다.

### 7. UI worklet과 JS callback의 경계

`onUpdate`, `onEnd`, `useAnimatedReaction`의 callback은 UI thread에서 실행될 수 있다. React state, 네비게이션, `console`, Expo Haptics 같은 JS 작업은 `runOnJS`로 호출한다.

특히 `twodos-slide`는 progress가 1에 도달하는 동안 callback이 계속 발생하므로 햅틱 함수를 debounce한 뒤 `runOnJS`로 실행한다. `drag-to-sort`, `pomodoro-timer`, `record-button`도 햅틱 호출 시점을 별도로 제어한다.

## 프로젝트별 인덱스

표의 기반 기술 약어는 다음과 같다.

- **R**: Reanimated
- **G**: Gesture Handler
- **S**: React Native Skia
- **SG**: `react-native-skia-gesture`
- **N**: React Navigation/Expo Router
- **H**: Expo Haptics
- **L**: Lottie
- **M**: Moti
- **C**: `react-native-fast-confetti`

### 스크롤·리스트·캐러셀

| 프로젝트 | 애니메이션 정리 | 핵심 파일 | 기반 |
| --- | --- | --- | --- |
| `3d-scroll-transition` | 숫자 리스트의 scroll offset을 opacity·rotateX·blur로 변환하고 Skia gradient text를 중앙에 맞춘다. | `src/index.tsx`, `src/components/blurred-list-item.tsx` | R+S |
| `animated-grid-list` | 스크롤 방향에 따라 grid가 회전하고, 아이템 추가·삭제에는 layout/entering/exiting을 적용한다. | `src/components/animated-layout-list/index.tsx` | R |
| `animated-indicator-list` | 측정한 header/item layout과 content offset을 이용해 indicator/header를 이동시킨다. | `src/hooks/useHeaderLayout.ts`, `src/hooks/useHeaderStyle.ts` | R |
| `audio-player` | waveform sample을 Skia로 그리며 pan 위치를 scrubber/current playing value로 변환한다. | `src/components/waveform-scrubber/` | R+G |
| `blurred-bottom-bar` | 스크롤되는 화면과 bottom tab bar, 선택 grid, gradient/blur를 하나의 navigation 예제로 결합한다. | `src/components/bottom-tab-bar.tsx`, `src/screens/blur/` | R+G+S+N |
| `blurred-scroll` | scroll 중심 아이템만 선명하게 보이도록 opacity·3D rotation·Skia blur/mask를 계산한다. | `src/index.tsx`, `src/components/BlurredItem.tsx` | R+S |
| `card-shader-reflections` | 수평 카드 carousel의 위치를 shader uniform으로 전달해 카드 표면 반사와 perspective를 만든다. | `src/components/card-carousel/card-carousel.tsx`, `src/components/card-carousel/card/card-canvas.component.tsx`, `card.shader.ts` | R+G+S |
| `circular-carousel` | 아이템의 상대 위치를 원형 각도로 바꿔 wheel/carousel 형태로 배치한다. | `src/components/circular-list/` | R |
| `clock-time-picker` | 세로 time range scroll과 Skia analog clock의 시침·분침/path를 날짜 값에 연결한다. | `src/components/clock.tsx`, `src/components/time-range.tsx` | R+S |
| `color-carousel` | horizontal scroll의 각 아이템 위치를 색상과 scale/opacity로 보간한다. | `src/components/carousel/`, `src/hooks/use-interpolated-color.ts` | R+S |
| `coverflow-carousel` | FlatList 아이템의 상대 위치를 perspective·rotation·scale·opacity로 변환해 Cover Flow를 만든다. | `src/components/coverflow-carousel/` | R+G |
| `dynamic-tab-indicator` | 측정한 각 탭의 x/width 사이를 scroll progress로 보간해 길이가 변하는 indicator를 만든다. | `src/components/dynamic-tab-indicator/` | R |
| `github-onboarding` | 페이지 scroll에 맞춰 background/color, pagination dot, 카드/콘텐츠 opacity를 바꾼다. | `src/components/colorful-onboarding/` | R+G |
| `imessage-stack` | scroll offset에 따라 메시지 카드가 겹쳐 쌓인 상태에서 위치와 scale을 바꾼다. | `src/cards/card.tsx` | R |
| `infinite-carousel` | 원형 carousel을 무한 반복하고 pan 종료 뒤 decay/spring으로 snap하며 위치에 따른 blur를 적용한다. | `src/components/infinite-circular-carousel/` | R+G+S |
| `miles-bar-chart` | chart scroll/selection progress로 막대 높이·색상·label opacity를 계산한다. | `src/components/weekly-chart/` | R |
| `scroll-island` | SectionList의 scroll을 header/island/donut progress에 연결해 축소·확장한다. | `src/components/section-list/` | R+S |
| `scroll-progress` | 문서 content offset과 높이로 읽기 progress를 계산하고 하단 영역을 collapsed/visible 상태로 바꾼다. | `src/section-content-list/` | R |
| `selectable-grid-list` | grid item의 선택·해제를 shared index 배열로 관리하며 opacity와 card 상태를 전환한다. | `src/components/SelectableGridList/` | R+G |
| `stacked-list` | 측정된 아이템 위치를 기준으로 카드가 겹쳐진 stack을 만든다. | `src/index.tsx` | R |
| `story-list` | story 카드 horizontal pan을 decay로 마무리하고 index/translation을 자연스럽게 정착시킨다. | `src/components/story-list/` | R+G |
| `swipe-cards` | 카드의 translation/rotation을 pan에 연결하고 다음 카드 preview, Skia pie chart, spring snap을 결합한다. | `src/components/Card/`, `src/hooks/use-swipe-controls.ts` | R+G+S |
| `twitter-tab-bar` | 탭 전환과 content scroll에 맞춰 active tab, floating button, tab bar의 visibility/progress를 제어한다. | `src/components/bottom-tab-bar/` | R+G+N |

### 버튼·입력·값 표시

| 프로젝트 | 애니메이션 정리 | 핵심 파일 | 기반 |
| --- | --- | --- | --- |
| `action-tray` | plus 버튼 press scale/rotate, bottom action tray pan/spring, backdrop opacity, 단계별 content height/layout을 조합한다. | `src/components/ActionTray/index.tsx`, `src/components/TouchableScale/` | R+G |
| `add-to-cart` | 리스트의 원래 버튼을 측정해 선택 버튼으로 morph하고, backdrop·confirm button·bottom sheet를 progress 하나로 동기화한다. | `src/index.tsx`, `src/components/confirm-button/`, `list-item/` | R+G |
| `airbnb-slider` | pan slider의 값을 `useAnimatedReaction`으로 price에 전달하고, 숫자 자릿수·통화 기호를 spring/timing으로 재배치한다. | `src/components/animated-slider/`, `animated-digit.tsx` | R+G |
| `alert-drawer` | alert drawer와 pressable scale, 활성 상태에 따른 opacity·background color를 timing으로 전환한다. | `src/components/alert-drawer/`, `pressable-scale.tsx` | R+G |
| `animated-3d-parallax` | 터치 위치를 기준으로 카드와 내부 콘텐츠에 서로 다른 spring config를 적용해 깊이 차이를 만든다. | `src/hooks/use-3d-rotation-style.ts`, `src/index.tsx` | R+G |
| `animated-clip-box` | 카드 내부 원을 spring으로 확장해 clip/overflow reveal을 만들고 radius에 따라 색상을 보간한다. | `src/components/clip-box-button/` | R |
| `animated-count-text` | 숫자를 자릿수별 세로 wheel로 렌더링하고 overflow hidden, spring translateY, fade/layout transition을 적용한다. | `src/components/animated-count.tsx`, `animated-digit.tsx` | R |
| `atlas-button` | 여러 개의 작은 square/particle을 Skia Atlas로 한 번에 렌더링하고 버튼 활성 상태에서 timing으로 배치한다. | `src/atlas-button/animated-squares.tsx` | R+S+G |
| `balance-slider` | 측정한 slider bounds 안에서 pan 위치를 제한하고, 손을 뗀 값은 spring으로 안정화한다. | `src/components/balance-slider/` | R+G |
| `checkbox-interactions` | 체크 상태의 mount/unmount와 layout을 entering/exiting으로 보여준다. | `src/components/checkbox.tsx` | R |
| `composable-text` | 문자열 변경 시 문자를 조합 단위로 렌더링해 per-character fade/layout transition을 적용한다. | `src/composable-text/index.tsx` | R+S |
| `cuberto-slider` | 수평 pan slider의 thumb와 border/path를 spring/timing으로 보정하고 Skia path로 track을 그린다. | `src/components/slider.tsx` | R+G+S |
| `delete-button` | delete/close 상태를 여러 shared value로 분리하고 gooey Skia path, blur, close button/text animation을 reaction으로 조정한다. | `src/components/delete-button.tsx`, `use-gooey-layer.tsx` | R+G+S |
| `dot-sheet` | 입력/선택 상태를 progress로 바꾸고 Skia background blur 및 custom press feedback으로 전환한다. | `src/components/card-input.tsx`, `background-gradient.tsx` | R+G+S |
| `duration-slider` | 원형 slider의 좌표를 angle/progress로 변환하고 Skia arc, picker path, duration text를 함께 갱신한다. | `src/components/circular-slider.tsx`, `picker.tsx` | R+G+S |
| `email-demo` | 리스트 아이템을 tap으로 지우고 shakeTranslateX를 repeat timing으로 흔든다. | `src/hooks/use-animated-shake.ts`, `src/components/interactive-list/` | R+G |
| `family-number-input` | keypad 입력에 따라 숫자 자릿수를 전환하며 입력 버튼과 숫자 mount/unmount를 layout/entering/exiting으로 표현한다. | `src/components/animated-number/`, `src/components/buttons-grid/` | R+G |
| `fluid-tab-interaction` | segmented control의 active index를 progress로 관리하고 선택 영역에 animated blur를 적용한다. | `src/components/segmented-control/`, `animated-blur-view.tsx` | R+S |
| `geometry-button` | tap 상태에 따라 Skia path geometry와 button label/opacity를 timing으로 바꾼다. | `src/geometry-button.tsx` | R+G+S |
| `loading-button` | loading arc progress를 repeat으로 돌리고 button label/icon을 layout/entering/exiting으로 교체한다. | `src/components/loading-button/` | R+G+S+M |
| `record-button` | record 상태, progress, line/path를 Skia로 그리며 press 완료와 haptic callback을 reaction으로 연결한다. | `src/components/record-button/` | R+G+S+H |
| `smooth-dropdown` | 토글된 dropdown 항목의 height/opacity/translation을 spring으로 펼치고 닫는다. | `src/components/dropdown/` | R |
| `split-button` | 하나의 버튼이 split action으로 바뀌는 상태를 scale, timing, layout/entering/exiting으로 표현한다. | `src/components/split-button/` | R+G |
| `steddy-graph-interaction` | graph의 포인트/선택 상태를 tap으로 바꾸고 Skia path와 label을 spring/timing으로 갱신한다. | `src/components/graph/` | R+G+S |
| `tab-navigation` | active tab에 따라 icon/label container width, gap, opacity를 interpolate한다. | `src/components/tabs/` | R+G |
| `twodos-slide` | friction slider와 Skia square animation을 분리된 real/clamped progress로 제어하고 완료 시 debounce haptic을 실행한다. | `src/components/friction-slider/`, `animated-squares/` | R+G+S+H |
| `wheel-picker` | draggable line picker의 scroll offset, snap, boundary gradient, animated count를 decoupled progress로 관리한다. | `src/components/draggable-slider/`, `animated-count/` | R+G+S |

### Sheet·modal·toast·navigation transition

| 프로젝트 | 애니메이션 정리 | 핵심 파일 | 기반 |
| --- | --- | --- | --- |
| `blurred-bottom-bar` | bottom bar 외에도 home/blur/scrollable screen을 포함한 navigation demo로, tab과 scroll 상태를 blur/gradient에 전달한다. | `src/components/bottom-tab-bar.tsx`, `src/screens/` | R+G+S+N |
| `bottom-bar-skia` | 탭 icon/path와 선택 indicator를 Skia Canvas에서 그리고 active progress로 색상·형상을 보간한다. | `src/components/bottom-tab-bar/` | S+N |
| `clerk-toast` | toast를 stack으로 쌓고 pan으로 swipe dismiss하며 backdrop/blur와 spring bottom position을 사용한다. | `src/stacked-toast-manager/` | R+G+S |
| `custom-drawer` | drawer item/icon의 위치와 active state를 derived value로 계산한다. | `src/components/drawer/` | R+N |
| `dynamic-blur-tabs` | scrollable screen과 bottom tab bar 사이의 focus, blur, gradient, tab tap 상태를 동기화한다. | `src/components/bottom-tab-bar/`, `src/screens/` | R+G+S+N |
| `expandable-mini-player` | mini player를 tab bar 위에서 전체 화면 sheet로 확장하고 pan/tap, border radius, color, safe area, content progress를 함께 처리한다. | `src/components/navigation/bottom-tab-bar/expanded-sheet/` | R+G+N |
| `floating-bottom-bar` | custom bottom tab bar의 opacity와 shader light를 Skia RuntimeEffect로 렌더링한다. | `src/components/bottom-tab-bar/shader-light/` | R+S+N |
| `floating-modal` | floating modal을 pan으로 움직이고 open/close 상태에 따라 backdrop/pointer events/translation을 전환한다. | `src/components/FloatingModal/` | R+G |
| `gl-transitions` | 현재 화면과 다음 화면을 `makeImageFromView`로 snapshot한 뒤 Skia fragment shader로 cross-zoom/directional-warp 등을 실행한다. | `src/providers/gl-transitions/`, `src/the-magic/` | R+S+N |
| `inner-shared-transition` | home/shared 화면 사이의 이미지/카드 전환을 shared progress, blur, pan, navigation callback으로 구성한다. | `src/screens/home.tsx`, `src/screens/shared.tsx` | R+G+N |
| `instagram-shared-transition` | Instagram 스타일 이미지 shared transition과 blurhash/image appearance, pan dismissal을 조합한다. | `src/components/animated-image.tsx`, `src/screens/` | R+G+S+N |
| `linear-tab-interaction` | React Navigation의 `current.progress`를 Reanimated mutable value로 복사해 여러 tab layer와 custom stack transition을 동시에 움직인다. | `src/navigation/custom/`, `src/components/navigation/` | R+N |
| `popup-handler` | 터치 위치와 측정값을 기준으로 blurred popup을 열고, long press/tap/pan으로 위치·선택 상태를 제어한다. | `src/BlurredPopup/` | R+G+S |
| `scrollable-bottom-sheet` | sheet pan과 내부 Animated.ScrollView를 조정해 sheet가 열린 뒤 content scroll을 자연스럽게 넘긴다. | `src/components/BottomSheet/ScrollableBottomSheet.tsx` | R+G |
| `skia-bottom-sheet` | Reanimated 없이 `react-native-skia-gesture`와 Canvas path/blur/mask로 custom sheet를 그린다. | `src/components/bottom-sheet/index.tsx` | S+SG |
| `stacked-bottom-sheet` | 여러 sheet를 manager/provider로 관리하고 각 sheet의 bottom/translateY를 pan/spring으로 스택한다. | `src/stacked-sheet-manager/` | R+G+S |
| `stacked-modals` | modal stack manager가 bottom position/opacity/color를 상태별로 계산하고 modal exit transition을 적용한다. | `src/stacked-modal-manager/` | R+G |
| `toast` | toast provider/manager가 toast를 stack하고 각 toast를 pan dismiss, spring enter, timing exit으로 처리한다. | `src/toast-manager/` | R+G |
| `telegram-theme-switch` | 전체 화면 snapshot을 Skia Canvas에 올리고 선택한 버튼 중심의 원형 clip을 확장하면서 실제 theme을 바꾼다. Lottie는 snapshot 위에서 icon을 보완한다. | `src/components/switch-theme/index.tsx`, `switch-theme-button.tsx` | R+G+S+L+N |
| `theme-canvas-animation` | Skia Canvas에서 이전/현재 배경을 circular clip으로 겹치고 square 선택 시 timing으로 reveal한다. | `src/index.tsx`, `src/selectable-square/` | S+SG |
| `twitter-tab-bar` | navigation tab과 scroll content, floating action button의 progress를 provider/context로 공유한다. | `src/components/bottom-tab-bar/` | R+G+N |

### Skia·shader·geometry 그래픽

| 프로젝트 | 애니메이션 정리 | 핵심 파일 | 기반 |
| --- | --- | --- | --- |
| `atlas-button` | Atlas texture로 여러 square를 batch render해 활성/비활성 시각 효과를 만든다. | `src/atlas-button/animated-squares.tsx` | R+S+G |
| `bezier-curve-outline` | control point를 움직여 Bezier outline을 만들고 progress, blur, animated square/path를 reaction으로 제어한다. | `src/components/bezier-outline.tsx`, `src/hooks/useAnimateThroughPath/` | R+G+S |
| `blur-circles` | 여러 원과 mask/blur를 Canvas에서 직접 그리는 순수 Skia 예제다. | `src/index.tsx`, `src/hooks/use-vec.ts` | S |
| `bottom-bar-skia` | SVG-like icon path와 selected tab shape를 Canvas에서 직접 렌더링한다. | `src/components/bottom-tab-bar/bottom-tab-item/` | S+N |
| `card-shader-reflections` | `card.shader.ts` fragment shader가 카드 좌표와 scroll progress를 이용해 반사광을 계산한다. | `src/components/card-carousel/card/card.shader.ts` | R+S |
| `exclusion-tabs` | tab text width와 exclusion path를 계산해 선택 영역을 custom path로 클리핑한다. | `src/components/exclusion-tabs/` | R+S |
| `fibonacci-shader` | slider 값과 시간 `iTime`을 RuntimeEffect uniform에 넣어 반복되는 Fibonacci 그래픽을 만든다. | `src/index.tsx`, `src/components/animated-slider/` | R+G+S |
| `fibonacci-shader-grid` | Fibonacci shader 위에 grid/control panel을 얹고 n·magical multiplier·time을 조절한다. | `src/components/control-panel/`, `animated-slider/` | R+G+S |
| `fluid-slider` | Skia gesture와 Canvas blur 기반으로 물성 있는 slider thumb/track을 그린다. | `src/components/fluid-slider/` | S+SG |
| `fourier-visualizer` | FFT/epicycle 계산 결과를 Skia path로 그리며 touch drawing과 Fourier reconstruction을 연결한다. | `src/components/fourier-visualizer/`, `utils/fft.ts` | R+G+S |
| `fractal-glass` | pan 좌표에 따라 fractal/glass mask와 blur layer를 이동시킨다. | `src/components/fractal-glass-mask.tsx` | R+G+S+SG |
| `grid-visualizer` | 입력 text와 측정된 geometry를 기준으로 Skia grid/path/blur 효과를 만든다. | `src/grid-visualizer.tsx` | R+G+S |
| `image-cropper` | corner pan gesture가 crop rectangle을 제한하고 Skia Canvas가 grid/border/path overlay를 렌더링한다. | `src/components/image-cropper/`, `useCornerGestures.ts` | G+S+SG |
| `metaball` | Skia path와 blur를 이용해 서로 붙는 metaball 형태를 만든다. | `App.tsx` | S+SG |
| `paper-folding` | progress를 fold angle/position/color/blur에 연결해 종이 접힘을 path와 gradient로 표현한다. | `src/paper/`, `src/background-gradient.tsx` | R+S |
| `prequel-slider` | 원형 progress slider와 image editor를 연결하고 RuntimeEffect shader transition을 적용한다. | `src/components/draggable-slider/`, `src/components/image-editor/` | R+G+S |
| `qr-code-generator` | QR matrix를 path로 변환한 뒤 slider/pan progress와 함께 Skia에서 표시한다. | `src/components/qrcode/`, `src/components/slider/` | R+G+S |
| `radar-chart` | data와 nextData 사이를 progress로 보간해 polygon grid/path를 그린다. | `src/components/radar-chart/` | R+S |
| `skia-color-picker` | pan 좌표를 원 안에 clamp하고 HSV shader/gradient와 picker path를 함께 갱신한다. | `src/components/color-picker/`, `shader.ts` | R+G+S |
| `slide-to-reveal` | horizontal pan progress로 masked/blurred content를 점진적으로 reveal한다. | `src/components/slide-to-reveal.tsx`, `text-code.tsx` | R+G+S |
| `spiral` | Skia path/mask/blur로 spiral graphic을 그리는 정적 geometry 예제다. | `src/index.tsx` | S |
| `steddy-graph-interaction` | graph line, selected point, tooltip을 Skia path와 shared progress로 렌더링한다. | `src/components/graph/` | R+G+S |
| `threads-holo-ticket` | ticket front/back을 3D flip하고, holographic background/QR을 Skia로 렌더링한다. | `src/components/ticket/`, `holographic-card.tsx` | R+G+S |
| `verification-code-face` | PIN 상태에 따라 face/icon path와 eye 상태를 Skia로 바꾸고 shake/enter/exit을 적용한다. | `src/components/verification-code/icon-square/` | R+S |
| `wheel-picker` | slider line geometry와 boundary gradient를 Skia로 그리고 숫자 wheel은 Reanimated로 움직인다. | `src/components/draggable-slider/` | R+G+S |

### 게임·텍스트·특수 효과

| 프로젝트 | 애니메이션 정리 | 핵심 파일 | 기반 |
| --- | --- | --- | --- |
| `animated-count-text` | 자릿수마다 0~9를 세로로 쌓고 translateY로 숫자를 바꾸는 전형적인 odometer 패턴이다. | `src/components/animated-digit.tsx` | R |
| `everybody-can-cook` | 문자를 개별로 나누고 delay를 누적해 3D flip wave를 만든다. ref로 animate/reset/toggle을 노출한다. | `src/components/staggered-text.tsx`, `staggered-digit.tsx` | R |
| `empty-qr-code` | QR share 상태와 letter/QR progress를 tap으로 전환하고 Skia QR path를 표시한다. | `src/components/qrcode-share/` | R+G+S |
| `family-number-input` | 숫자 입력에 따라 표시 자릿수와 keypad 상태가 바뀌는 입력 UI다. | `src/components/animated-number/` | R+G |
| `mobile-input` | PIN 입력, dot, circular stroke, animated face, 실패 shake를 여러 shared value로 동기화한다. | `src/components/AnimatedFace/`, `src/components/PinArea/` | R+G+S |
| `motion-blur` | 리스트/버튼 상태의 progress를 blur intensity와 opacity에 연결해 움직임 잔상을 만든다. | `src/components/blurred-list/`, `src/components/movie-image.tsx` | R+G+S |
| `particles-button` | press progress에 맞춰 particle blast를 staggered delay로 만들고 Skia에서 batch render한다. | `src/components/blast-effect/`, `circular-button.tsx` | R+G+S |
| `pomodoro-timer` | draggable timer slider, tick line, digit count, blur, haptic을 하나의 timer state로 연결한다. | `src/components/draggable-slider/`, `src/components/animated-count/` | R+G+S+H |
| `shake-to-delete` | long press로 shaking mode에 들어가고 item별 random variation을 넣은 rotation/translation을 repeat+sequence로 반복한다. | `src/apps-list/hooks/use-shaking-animation.ts`, `animation-config.ts` | R |
| `snake` | fling gesture로 게임 방향을 바꾸고 game tick마다 Skia path를 갱신하며 game-over/count transition을 처리한다. | `src/snake-game/` | R+G+S |
| `sudoku` | cell press/highlight와 board mount/unmount를 spring/layout로 표현하고 solve 완료 시 confetti를 실행한다. | `src/components/sudoku-board/` | R+C |
| `steps` | step index에 따라 dots와 split button을 바꾸며 layout/entering/exiting 및 press feedback을 사용한다. | `src/steps/` | R+G |
| `toast` | toast manager가 여러 toast를 쌓고 swipe/auto-dismiss/press scale을 조합한다. | `src/toast-manager/` | R+G |
| `verification-code` | 숫자 입력 성공/실패 상태에 맞춰 code number를 표시하고 shake와 enter/exit을 실행한다. | `src/components/verification-code/` | R+G |

## 프로젝트별 보충 메모

### 측정 기반 morphing

`add-to-cart`, `balance-slider`, `delete-button`, `duration-slider`, `grid-visualizer`, `popup-handler`, `stacked-list`, `telegram-theme-switch`는 `measure` 또는 `useAnimatedRef`를 사용한다. 이 방식은 “현재 View의 실제 화면 좌표”를 animation 시작점으로 삼을 수 있다는 장점이 있다. 단, 측정값이 아직 없을 때는 별도 초기 상태를 처리해야 하고, layout 변경 이후 stale measurement가 남지 않도록 다시 측정해야 한다.

### 스냅샷 전환

`gl-transitions`와 `telegram-theme-switch`는 일반 View를 애니메이션하는 대신 화면을 이미지로 캡처한다.

- `gl-transitions`: 이전 화면 snapshot과 다음 화면 snapshot을 shader의 `image1`/`image2`로 전달한다.
- `telegram-theme-switch`: 현재 화면 snapshot을 유지한 상태에서 실제 theme을 바꾸고, 원형 clip이 확장되는 동안 사용자에게는 이전 화면이 보이도록 한다.

이 기법은 복잡한 화면 전체를 한 번에 전환할 수 있지만 snapshot 생성 시점, 메모리, Canvas의 pointer events, transition 종료 후 image 해제를 함께 관리해야 한다.

### 제스처 조합

주로 다음 순서가 반복된다.

```text
onBegin  -> 시작 위치/현재 offset 저장
onUpdate -> translation을 clamp하여 shared value 갱신
onEnd    -> velocity 또는 threshold로 snap 목적지 결정
onFinalize -> 상태 reset, callback 또는 cleanup
```

bottom sheet 계열은 `Gesture.Simultaneous(tapGesture, panGesture)`를 사용하거나, tap과 pan의 활성 조건을 shared value로 분리한다. `expandable-mini-player`, `scrollable-bottom-sheet`, `stacked-bottom-sheet`, `toast`, `clerk-toast`에서 이 구조를 확인할 수 있다.

### 숫자·문자 애니메이션

- `animated-count-text`, `airbnb-slider`, `pomodoro-timer`, `snake`, `wheel-picker`는 숫자 하나를 0~9 세로 column으로 렌더링하는 odometer/wheel 방식을 사용한다.
- `everybody-can-cook`는 문자 단위 component와 누적 delay로 staggered flip을 만든다.
- `composable-text`는 문자열 변경 시 문자 단위 mount/layout transition을 사용한다.
- `staggered-card-number`는 `withDelay(index * delay, withSpring(...))`으로 각 숫자의 시작 시점을 늦춘다.

### 성능상 중요한 선택

- scroll event는 일반 React `onScroll`보다 `useAnimatedScrollHandler`로 UI thread에서 처리한다.
- FlatList 예제는 `getItemLayout`, `windowSize`, `snapToInterval`로 렌더링과 scroll 정착을 돕는다.
- blur는 넓은 영역에서 비용이 크므로 중앙/활성 상태에만 적용하거나 intensity를 0으로 만든다.
- particle은 개별 React View를 많이 만들기보다 Skia Atlas 또는 Canvas에서 batch render한다.
- UI worklet에서 JS callback을 매 프레임 실행하지 않도록 `useAnimatedReaction`, threshold, debounce를 사용한다.
- shader source는 렌더링 중 매번 생성하지 않고 `useMemo`로 만든다.

## 통합할 때의 주의점

1. **버전 통일**: Expo SDK, Reanimated, Skia, Gesture Handler를 먼저 하나의 호환 조합으로 정해야 한다.
2. **Babel 설정**: Reanimated를 쓰는 앱은 각 프로젝트의 `babel.config.js`에 있는 `react-native-reanimated/plugin` 설정을 확인한다.
3. **Gesture root**: Gesture Handler 기반 예제는 `GestureHandlerRootView`가 앱 최상단에 필요한지 확인한다.
4. **worklet 경계**: gesture callback 안에서 React state, navigation, Haptics를 직접 호출하지 말고 필요한 경우 `runOnJS`를 사용한다.
5. **measurement lifecycle**: `measure` 결과는 layout이 바뀌면 다시 계산하며, null/초기값을 명시적으로 처리한다.
6. **웹 지원**: Skia, native gesture, Lottie, haptic, snapshot API는 웹에서 동일하게 동작하지 않을 수 있다.
7. **접근성**: 애니메이션 View를 gesture detector로 감싼 경우 accessibility label, focus, reduced-motion 대체 동작을 별도로 추가해야 한다.
8. **pointer events**: backdrop와 snapshot Canvas를 화면 위에 놓을 때 animation 중에만 touch를 차단하고 종료 후에는 반드시 `none`으로 되돌린다.
9. **정리 작업**: 반복 animation은 unmount 시 cancel하고, snapshot/image와 listener를 transition 종료 후 해제한다.
10. **시각값과 논리값 분리**: slider의 rebound 효과와 실제 progress, sheet의 drag offset과 확정된 open/close 상태를 분리하면 callback·햅틱·비즈니스 로직이 안정적이다.

## 재사용 우선순위

여러 프로젝트에서 반복되는 부분을 실제 제품에 가져온다면 다음 순서가 효율적이다.

1. `PressableScale`: tap down/up/finalize scale feedback
2. `usePanSnap`: context offset, clamp, velocity/threshold snap
3. `ProgressDrivenSheet`: progress 기반 height/translateY/backdrop/pointer events
4. `AnimatedDigit`: 숫자별 0~9 vertical wheel
5. `useAnimatedScrollHandler` 기반 `ScrollInterpolatedItem`
6. Skia `MaskedReveal`/`BlurredCanvasLayer`
7. `useHapticOnThreshold`: threshold crossing 한 번만 JS로 전달
8. snapshot 기반 `ScreenTransitionProvider`

단, 원본 프로젝트는 각각 독립 예제이므로 위 컴포넌트를 합칠 때는 최신 프로젝트의 Reanimated/Skia API와 gesture lifecycle에 맞춰 타입·cleanup·reduced-motion 처리를 보강해야 한다.
