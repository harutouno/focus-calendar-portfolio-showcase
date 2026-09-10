# アーキテクチャ

データと権限の経路を示します。

```
┌─────────────────────────────────────────────────────────────┐
│ 画面 (app/)                        Expo Router              │
│   index / day / event / calendar/[id] / focus / records / ai │
│   描画のみを担当。整合性と権限の判定は下位層                 │
└───────────────┬─────────────────────────────────────────────┘
                │ useAppData()
┌───────────────▼─────────────────────────────────────────────┐
│ 状態管理 (src/context/)                                      │
│   AppDataContext   予定・カレンダー・同期の集約              │
│   AuthContext      認証セッションと identity の管理          │
│   LocaleContext / HolidayRegionContext                       │
└───────────────┬─────────────────────────────────────────────┘
                │ getServices()  ← DI (src/services/registry.ts)
┌───────────────▼─────────────────────────────────────────────┐
│ サービス (src/services/)          純関数 (src/utils/)        │
│   eventService      予定 CRUD      date / time / recurring   │
│   calendarService   共有・招待     permissions               │
│   focusTimerEngine  集中タイマー   inviteAuthority           │
│   notificationService              timelineLayout            │
│   writeEffectAuthority             aiScheduleToEvent         │
└──────┬──────────────────────────────────┬───────────────────┘
       │ 端末内                            │ クラウド
┌──────▼──────────────┐          ┌─────────▼───────────────────┐
│ AsyncStorage         │          │ Supabase                    │
│ (src/storage/)       │          │  Auth        認証           │
│  eventsRepository    │          │  PostgreSQL  テーブル 11    │
│  syncQueueRepository │◄────────►│  RLS         権限の正本     │
│  focusSession...     │  同期     │  RPC         招待・退出等   │
└──────────────────────┘          └─────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Demo AI (src/services/aiService.ts)                          │
│   DemoAIService が端末内で固定サンプル応答を生成             │
│   外部 LLM・API キー・Edge Function は含まない               │
│                                                              │
│   提案 → convertAiScheduleToNormalEvent → 確認ダイアログ     │
│        → AppDataContext.saveEvent（通常の保存経路と同一）    │
└─────────────────────────────────────────────────────────────┘
```

## 設計方針

### 1. 権限の正本を Row Level Security に置く

画面層とサービス層でも権限判定を行いますが、その目的は UI 制御です。
これらの判定を除いた場合でも、データベースが他ユーザーの行を返さない構成にしています。
判定箇所が増えても保護範囲が変わらないため、権限の保証点を 1 か所に維持できます。

### 2. 計算処理を純関数として分離する

日時計算、繰り返し展開、レイアウト計算、権限判定は `src/utils/` の純関数として実装しています。
コンポーネントに埋め込むと単体テストの対象にできず、描画の変更が計算の挙動へ波及します。
分離により、境界条件をテストで固定でき、UI の変更が計算結果に影響しない構成にしています。

### 3. 端末内保存とクラウド保存の入口を統一する

画面層は保存先を意識しません。`AppDataContext.saveEvent()` がカレンダー種別を判定し、
`eventService` のローカル経路と共有経路へ振り分けます。
オフライン時は同期キューへ保持し、復帰時にユーザー単位で分離して処理します。
