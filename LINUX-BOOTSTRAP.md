# Linux bootstrap — get a fresh box ready to build + run Claude

One-time setup to take a bare **Ubuntu 24 (x86_64, with a desktop)** machine to "ready to cut a Linux
release." Follow top to bottom. Once done, the actual build is in `LINUX-BUILD.md` (READ-FIRST block).

> Confirm the box first: `uname -m` must print **x86_64** (not aarch64), and you want a graphical
> session so you can GUI-test "Set one up for me" after building.

## 1. System packages
```bash
# Node 20 LTS (apt's nodejs is too old for electron-builder) — via NodeSource:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git build-essential libfuse2t64
#   libfuse2t64 = FUSE (the AppImage won't mount without it; on Ubuntu 24 it's *t64, not libfuse2)

# PyInstaller in a venv (Ubuntu 24 blocks system pip — PEP 668):
python3 -m venv ~/.venv
source ~/.venv/bin/activate          # must be active in the shell that runs release-linux.sh
pip install pyinstaller
```

## 2. Claude Code
```bash
npm install -g @anthropic-ai/claude-code      # or: curl -fsSL https://claude.ai/install.sh | bash
```

## 3. The project
```bash
git clone https://github.com/spiralocean/notzero
cd notzero
cd desktop && npm install && cd ..            # one-time; lets electron-builder run
```

## 4. Git push credentials (so the Claude here can push)
The HTTPS clone is read-only until you authenticate. Easiest:
```bash
sudo apt install -y gh        # GitHub CLI
gh auth login                 # pick HTTPS + your account; sets up the push credential
git config --global user.name  "Stephen Zinn"
git config --global user.email "sz@spiralocean.com"
```

## 5. rclone → R2 (so `release-linux.sh` can publish)
The release script uploads to the `notzero-dl` R2 bucket via an rclone remote named `r2`.
```bash
curl https://rclone.org/install.sh | sudo bash      # current rclone (apt's is old)
mkdir -p ~/.config/rclone
```
Then copy the **`[r2]` block** from your mac's `~/.config/rclone/rclone.conf` (the section with the
account id + access keys) into `~/.config/rclone/rclone.conf` on this box. Verify:
```bash
rclone lsf r2:notzero-dl | head     # should list the published mac/win files
```
*(No `release.env` needed on Linux — that's Apple-notarization only. Linux just needs the `r2` remote.)*

## 6. Start Claude on the project
```bash
claude            # first run: authenticate via browser (you have a GUI) or `export ANTHROPIC_API_KEY=...`
```
First prompt to it:
> Read `LINUX-BUILD.md` (start with the READ-FIRST block), then build and publish the Linux release with
> `scripts/release-linux.sh`. The PyInstaller venv is at `~/.venv` — activate it first.

## 7. Sanity check (Claude can self-verify this)
```bash
uname -m                                   # x86_64
node -v                                    # v20.x
source ~/.venv/bin/activate && pyinstaller --version
rclone lsf r2:notzero-dl >/dev/null && echo "r2 ok"
git -C ~/notzero remote -v                 # origin = spiralocean/notzero
```
All green → run `./scripts/release-linux.sh` (see `LINUX-BUILD.md`).

## Notes
- Your **global** `~/.claude/CLAUDE.md` and the mempalace MCP from the mac don't exist here — that's fine,
  none of it is needed for the build. The **project** context (`CLAUDE.md`, `LINUX-BUILD.md`, scripts) comes
  with the clone.
- Protocol, same as the other platforms: **`git pull` before starting, `git push` when done.**

---

[a **spiralocean** project](https://spiralocean.com)
