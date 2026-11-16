# KreuzenTV PVR for Android TV

対象は Kodi 21.3 Omega の ARM 32ビット版（armeabi-v7a）と Android TV 10（API 29）です。Kodi 21.2と21.3は同じPVR API 8.3.0のため、PVRには既存の0.2.1 ZIPを使います。

1. ZIPをAndroid TVから参照できる場所に置きます。
2. Kodiの「ZIPファイルからインストール」で `pvr.kreuzentv-0.2.1-android-armv7.zip` を選びます。
3. PVRクライアントの「KreuzenTV PVR」を有効化し、設定でAndroid TVから到達できるKreuzenTVのURLを入力します。
4. Kodiの「テレビ」画面でチャンネル、番組表、録画、タイマーを開きます。

番組表のサイドメニューにある「グループ」で「地上波」「BS」「CS」を切り替えます。KreuzenTVで非表示にした局はグループからも除外し、表示できる局がある放送波だけを登録します。「すべてのチャンネル」はKodiが作成する標準グループです。

番組表から単発の録画予約を登録でき、タイマー画面から取り消せます。保存先にサブフォルダが指定された録画は、PVRの録画一覧でフォルダに分類されます。保存先やエンコード設定、自動予約ルールをKodi上で操作する場合は、同じ方法で `plugin.video.kreuzentv-0.3.0.zip` もインストールし、「ビデオアドオン」から開きます。

ビデオアドオンの「番組表」から「放送中・次の番組」「今日の番組表」「日付から探す」を選べます。放送波と局を選ぶと、局ロゴ付きの番組一覧を放送時刻順に表示します。番組を選ぶと説明の表示、単発予約、自動予約ルールの作成ができます。

このZIPはKodi 21.2の開発ヘッダーとAndroid NDK r27cでビルドしました。両アドオンの初期接続先は `http://192.168.100.205:8781` です。既存アドオンから更新する際は保存済みのサーバーURLも確認してください。Android TV上でのインストールと動作は未確認です。

ビルドには上記SDKのヘッダーと、nlohmann/json 3.11.3の単一ヘッダーを使用します。

```sh
armv7a-linux-androideabi29-clang++ -std=c++17 -O2 -fPIC -fvisibility=hidden \
  -static-libstdc++ -shared -I "$KODI_DEV_KIT_INCLUDE" -I "$JSON_INCLUDE" \
  PvrClient.cpp -o libpvr.kreuzentv.so
```
