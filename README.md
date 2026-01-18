# google-news-rss-cleaner

Google News の RSS フィードを入力として受け取り、
各エントリーのリンクを **実際の元記事URLに解決した RSS** を返す小さな HTTP サービスです。

Google News RSS は現在、単純なリダイレクトではなく JS を用いた中継ページになっているため、
このサービスでは **ヘッドレスブラウザ（Playwright）** を用いて「人間が踏んだのと同じ挙動」で URL を解決します。

本サービスは **LAN 内利用を前提**とし、
上位レイヤー（例: tomato-shrieker）でキャッシュを持つことを想定しています。

## 特徴

- Google News RSS → 通常の RSS に変換
- `<link>` は元記事の最終URL
- `<guid>` は Google News 側 URL（安定性重視）
- 本文抜粋なし（description は空）
- pubDate はソース RSS の値をそのまま使用
- Node.js + Playwright
- キャッシュは URL 解決結果のみ（プロセス内）
- LAN 内限定運用前提

## 想定構成

```
FreeBSD / tomato-shrieker
→（HTTP / RSS）
Ubuntu / google-news-rss-cleaner
→（Playwright / Chromium）
Google News / 元記事サイト
```

- ブラウザ依存・OS依存が強い処理は Ubuntu 側に隔離
- tomato-shrieker 側では通常の RSS として扱う

## 動作環境

- Ubuntu（22.04 以降推奨）
- Node.js 24 以上
- Playwright（Chromium）

※ FreeBSD では Playwright が公式サポート外のため非対応

## セットアップ

### リポジトリ配置

/opt に配置する例：

```bin
cd /opt
git clone <this-repository> google-news-rss-cleaner
cd google-news-rss-cleaner
```

### 依存関係のインストール

```bin
npm ci
npx playwright install --with-deps chromium
```

## 起動

### 開発・確認用

```bin
npm start
```

デフォルトで 0.0.0.0:3000 で待ち受けます。

## systemd で常時起動（推奨）

### サービスユーザー作成

```bin
sudo useradd --system --create-home --home /var/lib/googlenews --shell /usr/sbin/nologin googlenews
sudo chown -R googlenews:googlenews /opt/google-news-rss-cleaner
```

### unit ファイル

/etc/systemd/system/google-news-rss-cleaner.service

```systemd
[Unit]
Description=Google News RSS Cleaner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=googlenews
WorkingDirectory=/opt/google-news-rss-cleaner
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
LimitNOFILE=65536

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/google-news-rss-cleaner /var/lib/googlenews

[Install]
WantedBy=multi-user.target
```

有効化と起動：

```bin
sudo systemctl daemon-reload
sudo systemctl enable --now google-news-rss-cleaner
sudo systemctl status google-news-rss-cleaner --no-pager
```

## 使い方

### 検索語を指定する場合

http://service-server:3000/clean?q=プリキュア

内部的に以下の Google News RSS を生成して処理します。

https://news.google.com/rss/search?q=プリキュア&hl=ja&gl=JP&ceid=JP:ja

## 設計方針・割り切り

- URL 解決はヘッドレスブラウザで実行
- 機械的な JS 解釈は行わない
- キャッシュは上位レイヤー（tomato-shrieker 等）で持つ
- 本サービスは
  「Google News RSS を人間向け挙動で正規化する踏み台」
  に徹する

## 注意事項

- Google News 側の仕様変更により動作が変わる可能性があります
- 失敗時は Google News 側 URL をそのまま返すため、RSS が壊れることはありません
- LAN 内利用を前提としています（外部公開は非推奨）
