# docker-mirakurun-epgstation

[Mirakurun](https://github.com/Chinachu/Mirakurun) + [EPGStation](https://github.com/l3tnun/EPGStation) の Docker コンテナ

## 前提条件

- Docker, Docker Compose v2 (`docker compose`) の導入が必須
- ホスト上の pcscd は停止する
- チューナーのドライバが適切にインストールされていること

## インストール手順

このフォークは tv_live リポジトリの一部で、イメージのビルドと起動は `../launch.sh` で行う
(テストなどの手順は `../setup.txt`)。`setup.sh` は存在しない設定ファイルをテンプレートから作成するだけで、
コンテナは起動しない。

```sh
sh setup.sh

#チャンネル設定
vim mirakurun/conf/channels.yml

#イメージのビルド (.env にバージョンを書き込む)
bash ../launch.sh build
```

## 起動

```sh
bash ../launch.sh start
```

## チャンネルスキャン地上波のみ(取得漏れが出る場合もあるので注意)

```sh
curl -X PUT "http://localhost:40772/api/config/channels/scan"
```

mirakurun の EPG 更新を待ってからブラウザで http://DockerHostIP:8888 へアクセスし動作を確認する

## 停止

```sh
bash ../launch.sh stop
```

## 更新

```sh
# srcs/Mirakurun と srcs/EPGStation からイメージをビルドし直して起動
bash ../launch.sh build
bash ../launch.sh restart
```

## 設定

### Mirakurun

* ポート番号: 40772

### EPGStation

* ポート番号: 8888
* ポート番号: 8889

### 各種ファイル保存先

* 録画データ

```./recorded```

* サムネイル

```./epgstation/thumbnail```

* 予約情報と HLS 配信時の一時ファイル

```./epgstation/data```

* EPGStation 設定ファイル

```./epgstation/config```

* EPGStation のログ

```./epgstation/logs```

## v1からの移行について

[docs/migration.md](docs/migration.md)を参照
