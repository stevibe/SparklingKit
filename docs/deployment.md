# Application deployment and upgrades

SparklingKit's release distribution is a Docker Compose application containing the prebuilt workspace image and Redis. AI services are configured after the web panel starts and are not bundled into the application image.

## Install from the hosted release

```bash
curl -fsSLO https://run.sparklingkit.com/stable/install.sh
less install.sh
bash install.sh
```

The installer requires Docker Engine, Docker Compose v2, and curl. It does not install Docker, use `sudo`, or remove an existing installation. By default it creates `./sparklingkit` beneath the current directory. Use another location with:

```bash
bash install.sh --dir /srv/sparklingkit
```

## Install from GitHub source

```bash
git clone https://github.com/stevibe/SparklingKit.git
cd SparklingKit
./distribution/install.sh --from-source --dir /srv/sparklingkit
```

The source and hosted paths install the same three operational files:

```text
/srv/sparklingkit/
├── compose.yaml
├── sparklingkit
└── data/
    ├── .redis/
    ├── config/
    ├── jobs/
    ├── chats/
    └── ...
```

`./data:/data` is a direct bind mount. Copying the installation directory while the containers are stopped therefore captures the complete durable workspace and Redis state.

## Network access

The default release binds port 54321 on all host interfaces so phones and other trusted-network devices can open `http://SERVER-IP:54321`. SparklingKit does not currently include multi-user authentication; place it behind a VPN or authenticated reverse proxy and do not expose port 54321 directly to the public internet.

To bind only to the local machine, create `.env` beside `compose.yaml`:

```dotenv
SPARKLINGKIT_BIND=127.0.0.1
SPARKLINGKIT_PORT=54321
SPARKLINGKIT_IMAGE=ghcr.io/stevibe/sparklingkit:latest
```

## Routine operations

Run commands from the installation directory:

```bash
./sparklingkit start
./sparklingkit status
./sparklingkit logs
./sparklingkit restart
./sparklingkit stop
```

`stop` does not use `docker compose down --volumes` and never removes `./data`.

## Upgrade

```bash
./sparklingkit update
```

The update command:

1. downloads the current Compose and management files from the release channel;
2. verifies both files against the published SHA-256 manifest;
3. retains the previous operational files and running image identity for rollback;
4. pulls the image selected by `SPARKLINGKIT_IMAGE` and the configured Redis image;
5. recreates changed containers without touching the bind mount;
6. waits for `/api/health`; and
7. reports the local and LAN URLs.

The default image follows the stable `latest` channel. For controlled upgrades, pin a version in `.env`:

```dotenv
SPARKLINGKIT_IMAGE=ghcr.io/stevibe/sparklingkit:0.2.0
```

Change the version deliberately and run `./sparklingkit update`. Versioned Compose files attached to GitHub releases are already pinned to the matching semantic version.

## Roll back the application image

If the previous image is still in Docker's local cache:

```bash
./sparklingkit rollback
```

This creates a local Compose override for the recorded image and recreates only the application container. Run `./sparklingkit update` to leave rollback mode and return to the image configured in `compose.yaml` or `.env`.

Rollback does not reverse persisted schema migrations. SparklingKit migrations must therefore remain additive and backward-conscious. Back up the installation directory before a major-version upgrade.

## Back up and restore

Stop the application before taking a filesystem-level backup:

```bash
./sparklingkit stop
tar -czf sparklingkit-data-backup.tar.gz data
./sparklingkit start
```

To restore, stop the containers, replace `./data` with the backup, and start the same or a compatible SparklingKit version.

## Release artifacts

Tagging a release runs `.github/workflows/release.yml`, which:

- validates the TypeScript source and tests;
- builds `linux/amd64` and `linux/arm64` images;
- publishes semantic-version and `latest` tags to GHCR;
- attaches SBOM and provenance metadata;
- attests the container and release assets;
- publishes version-pinned Compose and management files; and
- creates a checksum-verified DGX model-stack bundle.

`run.sparklingkit.com/stable/` should mirror the current release's `install.sh`, `compose.yaml`, and `sparklingkit` assets. Versioned GitHub release assets remain the immutable source of truth.
