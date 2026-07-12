# 剣道ムービーコーチ

剣道の試合動画に、コーチの音声解説と字幕（焼き込み）を付けてMP4として書き出すWebアプリ。
**すべての処理はブラウザ内で完結**し、動画・音声は外部サーバーに送信されない。

## 構成

- `index.html` / `style.css` / `app.js` — 静的ファイルのみ。ビルド不要、サーバー処理なし。
- 書き出しは ffmpeg.wasm を使わず、`canvas.captureStream()` + `MediaRecorder` によるリアルタイム再録画方式。
  iOSのハードウェアH.264エンコードが効くため、動画の実時間（最大5分）で確実に完了する。
- 音声は Web Audio API で「元の試合音声 + コメント音声（音量バランス調整可）」をミックスし、同じMediaStreamに合流。
- 字幕はCanvasに直接描画して焼き込み（画面下部・白文字・黒縁取り）。
- 音声認識は Web Speech API（`webkitSpeechRecognition`、ja-JP）。

## GitHub Pages へのデプロイ（Windows / PowerShell）

マイク使用にはHTTPSが必須のため、iPhone実機テストはGitHub Pages上で行う。

ローカルのgitリポジトリはコミット済み。GitHubへの公開は次の手順で行う。

### 方法A: GitHub CLI（未インストールなら `winget install GitHub.cli` → `gh auth login`）

```powershell
cd "C:\Users\samur\Dropbox\Claude Code\Movie coach"
gh repo create kendo-movie-coach --public --source . --push
# Pages を有効化（main ブランチのルートを公開）
gh api repos/{owner}/kendo-movie-coach/pages -X POST -f "source[branch]=master" -f "source[path]=/"
```

### 方法B: ブラウザで手動

1. github.com → New repository →「kendo-movie-coach」(Public) を作成
2. 表示されるコマンドに従って push:
   ```powershell
   cd "C:\Users\samur\Dropbox\Claude Code\Movie coach"
   git remote add origin https://github.com/<ユーザー名>/kendo-movie-coach.git
   git push -u origin master
   ```
3. リポジトリの Settings → Pages → Branch: `master` / `/ (root)` → Save

数分後に `https://<ユーザー名>.github.io/kendo-movie-coach/` で公開される。

更新時は:

```powershell
git add -A; git commit -m "update"; git push
```

※ iPhone側で古いキャッシュが残ることがある。動作が変わらないときはSafariのタブを閉じて開き直す。

## iPhone実機テスト手順

共通: iPhoneのSafariで公開URLを開く。テスト用に30秒程度の短い試合動画を用意しておくと早い。

### Step 1 — 動画再生・同期録音・音声ミックス

1. 「動画ファイルを選ぶ」→ 写真ライブラリから試合動画を選択
   - ✅ 動画情報（長さ・サイズ・解像度）が表示される
   - ✅ ▶ボタンで再生でき、シークバーが動く
2. Step 2 へ →「録音スタート」
   - ✅ 初回にマイク許可ダイアログが出る → 許可
   - ✅ 動画が再生され、左上に赤い「録音中」バッジが出る
   - ✅ 話しながら10秒ほど録音 →「録音ストップ」
3. 録音済みリストの「▶」で該当場面から再生
   - ✅ **試合の音と自分の声がミックスされて**聞こえる（イヤホン推奨）
   - ✅ 音量が Step 4 のスライダーで変わる
4. 途中の時間にシークしてもう一度録音（録り直し）
   - ✅ 重なった区間は新しい録音が優先して聞こえる

### Step 2 — 音声認識・字幕編集

1. 「音声認識で字幕を自動生成する」がONの状態で録音
   - ✅ 話すと画面に認識テキストがリアルタイム表示される
   - ⚠️ もし「録音がほぼ無音でした」の警告が出たら、そのiOSバージョンでは認識と録音が同時に使えない
     → 認識をOFFにして録音し、字幕は手入力（下記の代替案も参照）
2. Step 3 の編集画面で
   - ✅ 認識された字幕が時間順に並ぶ
   - ✅ テキストを修正できる／時間（分:秒.小数）を変更できる
   - ✅ 「▶」でその場面を再生すると、動画上に字幕プレビューが出る
   - ✅ 「＋現在位置に字幕を追加」で手動追加できる

### Step 3 — 書き出し・写真アプリ保存

1. Step 4 で音量バランスを調整 → プレビュー再生で確認
2. 「書き出しスタート」
   - ✅ 進捗バーが動き、動画の実時間で完了する
   - ⚠️ 書き出し中は画面ロック・アプリ切り替えをしない（録画が止まる）
3. 完了後「📱 写真アプリに保存」→ 共有シートで「ビデオを保存」
   - ✅ 写真アプリで開き、映像・字幕・ミックス音声（試合音+コメント）を確認
   - ✅ 字幕が画面下部に白文字+黒縁取りで焼き込まれている

## 音声認識に関する注意と代替案

- Web Speech API はiOS側でApple(Siri)の音声認識サービスを使うため、**コメント音声（コーチの声）のみ**Appleのサーバーで処理される。試合動画・映像は一切外部に出ない。
- iOSのバージョンによっては「マイク録音（MediaRecorder）と音声認識（SpeechRecognition）の同時使用」でどちらかが無音になる既知の問題がある。本アプリは録音が無音だった場合に自動で警告を出す。
- 認識が使えない/精度が不十分な場合の代替案:
  1. **手入力**（実装済み）: Step 3 の編集画面で字幕を手動追加。
  2. **whisper のブラウザ内実行**（将来オプション): transformers.js + whisper-tiny/base を使えば、録音済み音声から完全オンデバイスで認識できる。モデルDL約40〜150MB・処理は実時間の数倍かかるが、精度が高く外部送信ゼロ。必要なら Step 2b として追加実装する。

## 既知の制約

- ページを再読み込みすると作業内容（録音・字幕）は消える（すべてメモリ上のため）。
- 書き出しはリアルタイム再録画のため、動画の長さと同じ時間がかかる。
- Windows/Chromeでも動作するが（開発確認用）、ブラウザによってはWebM形式での書き出しになる。iPhoneのSafariではMP4/H.264で書き出される。
- 録音中に本体スピーカーで試合音声を鳴らすとマイクが拾う（エコー）。既定で「録音中は試合の音を消す」がON。試合音を聞きながら録音したい場合はイヤホンを使い、このチェックを外す。
