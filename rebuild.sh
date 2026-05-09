#!/usr/bin/env bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' 

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

print_info() {
    echo -e "${BLUE}==>${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

usage() {
    echo "Usage: $0 [hostname] [options]"
    echo ""
    echo "Rebuild Nix configuration (Darwin or Home Manager)."
    echo ""
    echo "Arguments:"
    echo "  hostname      The host to build (optional, tries to detect automatically)"
    echo ""
    echo "Options:"
    echo "  -h, --help    Show this help message"
    echo "  --ask         Preview changes before applying (requires nh)"
    echo "  --home        Rebuild only Home Manager configuration"
    echo "  --no-nh       Force use of native tools even if nh is available"
    echo "  --profile     Set package profile (thin or full)"
    echo "  --            Pass remaining arguments to rebuild tool"
    echo ""
    echo "Examples:"
    echo "  $0                      # Build current host"
    echo "  $0 m1p                  # Build the M1 Pro MacBook host"
    echo "  $0 m5m                  # Build the M5 Max MacBook host"
    echo "  $0 --ask                # Preview changes before applying"
    echo "  $0 --profile full       # Switch package profile and rebuild"
    echo "  $0 -- --show-trace      # Pass extra args to rebuild tool"
}

HOST=""
EXTRA_ARGS=()
PARSE_EXTRA=false
USE_NH=true
ASK_FLAG=false
HOME_ONLY=false
PROFILE=""
EXPECT_PROFILE=false

SYSTEM_TYPE="unknown"
if [[ "$(uname -s)" == "Darwin" ]]; then
    SYSTEM_TYPE="darwin"
elif [[ "$(uname -s)" == "Linux" ]]; then
    SYSTEM_TYPE="linux"
else
    print_error "Unsupported system: $(uname -s)"
    exit 1
fi

for arg in "$@"; do
    if [[ "$PARSE_EXTRA" == "true" ]]; then
        EXTRA_ARGS+=("$arg")
    elif [[ "$EXPECT_PROFILE" == "true" ]]; then
        PROFILE="$arg"
        EXPECT_PROFILE=false
    elif [[ "$arg" == "--" ]]; then
        PARSE_EXTRA=true
    elif [[ "$arg" == "-h" ]] || [[ "$arg" == "--help" ]]; then
        usage
        exit 0
    elif [[ "$arg" == "--no-nh" ]]; then
        USE_NH=false
    elif [[ "$arg" == "--ask" ]]; then
        ASK_FLAG=true
    elif [[ "$arg" == "--home" ]]; then
        HOME_ONLY=true
    elif [[ "$arg" == "--profile" ]]; then
        EXPECT_PROFILE=true
    elif [[ "$arg" == --profile=* ]]; then
        PROFILE="${arg#--profile=}"
    elif [[ -z "$HOST" ]]; then
        HOST="$arg"
    else
        print_error "Unknown argument: $arg"
        usage
        exit 1
    fi
done

if [[ "$EXPECT_PROFILE" == "true" ]]; then
    print_error "Missing value for --profile"
    usage
    exit 1
fi

if [[ -n "$PROFILE" ]] && [[ "$PROFILE" != "thin" ]] && [[ "$PROFILE" != "full" ]]; then
    print_error "Invalid profile: $PROFILE (expected thin or full)"
    usage
    exit 1
fi

host_config_exists() {
    local hostname="$1"

    [[ -f "$SCRIPT_DIR/hosts/$hostname.nix" ]]
}

list_hosts() {
    local file=""

    for file in "$SCRIPT_DIR"/hosts/*.nix; do
        [[ -e "$file" ]] || continue
        basename "$file" .nix
    done | sort -u
}

find_host_config() {
    local hostname="$1"

    case "$hostname" in
        mbp)
            hostname="m5m"
            ;;
        mbp-old|macbook)
            hostname="m1p"
            ;;
        ludwigs-mac-mini|Ludwigs-Mac-mini)
            hostname="macmini"
            ;;
    esac

    if host_config_exists "$hostname"; then
        echo "$hostname"
        return 0
    fi

    while IFS= read -r candidate; do
        if [[ "$hostname" == "$candidate"* ]] || [[ "$candidate" == "$hostname"* ]]; then
            echo "$candidate"
            return 0
        fi
    done < <(list_hosts)

    return 1
}

collect_detected_hosts() {
    local detected_hosts=()
    local candidate=""

    if command -v hostname &> /dev/null; then
        candidate=$(hostname -s 2>/dev/null || true)
        if [[ -n "$candidate" ]]; then
            detected_hosts+=("$candidate")
        fi
    elif [[ -f /etc/hostname ]]; then
        candidate=$(cat /etc/hostname)
        if [[ -n "$candidate" ]]; then
            detected_hosts+=("$candidate")
        fi
    elif command -v hostnamectl &> /dev/null; then
        candidate=$(hostnamectl --static 2>/dev/null || true)
        if [[ -n "$candidate" ]]; then
            detected_hosts+=("$candidate")
        fi
    fi

    if [[ "$SYSTEM_TYPE" == "darwin" ]] && command -v scutil &> /dev/null; then
        candidate=$(scutil --get LocalHostName 2>/dev/null || true)
        if [[ -n "$candidate" ]]; then
            detected_hosts+=("$candidate")
        fi

        candidate=$(scutil --get ComputerName 2>/dev/null || true)
        if [[ -n "$candidate" ]]; then
            detected_hosts+=("$candidate")
        fi
    fi

    printf '%s\n' "${detected_hosts[@]}"
}

if [[ -z "$HOST" ]]; then
    DETECTED_HOSTS=()
    while IFS= read -r detected_host; do
        if [[ -n "$detected_host" ]]; then
            DETECTED_HOSTS+=("$detected_host")
        fi
    done < <(collect_detected_hosts)

    for DETECTED_HOST in "${DETECTED_HOSTS[@]}"; do
        if HOST_CONFIG=$(find_host_config "$DETECTED_HOST"); then
            HOST="$HOST_CONFIG"
            print_info "Auto-detected host configuration: $HOST"
            break
        fi
    done

    if [[ -z "$HOST" ]] && host_config_exists "quietbox"; then
        for DETECTED_HOST in "${DETECTED_HOSTS[@]}"; do
            if [[ "$DETECTED_HOST" == "archlinux" ]]; then
                HOST="quietbox"
                print_info "Detected Arch Linux system, using host configuration: $HOST"
                break
            fi
        done
    fi

    if [[ -z "$HOST" ]] && [[ "$SYSTEM_TYPE" == "darwin" ]] && host_config_exists "m1p"; then
        for DETECTED_HOST in "${DETECTED_HOSTS[@]}"; do
            if [[ "$DETECTED_HOST" == *"MacBook"* ]]; then
                HOST="m1p"
                print_info "Falling back to M1 Pro MacBook host configuration: $HOST"
                break
            fi
        done
    fi

    if [[ -z "$HOST" ]]; then
        DETECTED_HOST="${DETECTED_HOSTS[0]:-unknown}"
        print_error "Could not auto-detect host configuration for: $DETECTED_HOST"
        print_info "Available hosts:"
        list_hosts | sed 's/^/  - /'
        exit 1
    fi
else
    if ! host_config_exists "$HOST"; then
        if HOST_CONFIG=$(find_host_config "$HOST"); then
            HOST="$HOST_CONFIG"
            print_info "Found matching host configuration: $HOST"
        else
            print_error "Host configuration not found: $HOST"
            print_info "Available hosts:"
            list_hosts | sed 's/^/  - /'
            exit 1
        fi
    fi
fi

cd "$SCRIPT_DIR"

if [[ "$HOME_ONLY" == "true" ]]; then
    HOME_CONFIG_NAMES=$(nix eval --json "$SCRIPT_DIR#homeConfigurations" --apply builtins.attrNames 2>/dev/null || true)
    if [[ -z "$HOME_CONFIG_NAMES" ]]; then
        print_error "Unable to read homeConfigurations from flake."
        exit 1
    fi

    if ! echo "$HOME_CONFIG_NAMES" | grep -q "\"$HOST\""; then
        AVAILABLE_HOME_CONFIGS=$(echo "$HOME_CONFIG_NAMES" | tr -d '[]"' | tr ',' ' ')
        print_error "Home-only rebuild requested, but homeConfigurations.$HOST is not defined."
        print_info "Available homeConfigurations: ${AVAILABLE_HOME_CONFIGS:-none}"
        print_info "Run without --home or add a standalone Home Manager config for this host."
        exit 1
    fi
fi

if [[ -n "$PROFILE" ]]; then
    PROFILE_FILE="$SCRIPT_DIR/profiles/package/$HOST.nix"
    print_info "Setting package profile for $HOST to $PROFILE"
    mkdir -p "$(dirname "$PROFILE_FILE")"
    cat > "$PROFILE_FILE" <<EOF
{ ... }:
{
  packages.profile = "$PROFILE";
}
EOF
fi

SCRIPT_NIX_CONFIG=$(
    cat <<'EOF'
extra-experimental-features = nix-command flakes pipe-operators
accept-flake-config = true
eval-cache = true
EOF
)

if [[ -n "${NIX_CONFIG:-}" ]]; then
    export NIX_CONFIG="${NIX_CONFIG}"$'\n'"${SCRIPT_NIX_CONFIG}"
else
    export NIX_CONFIG="${SCRIPT_NIX_CONFIG}"
fi

if command -v nh &> /dev/null && [[ "$USE_NH" == "true" ]]; then
    print_info "Using nh for rebuild (better UX)..."

    if [[ "$HOME_ONLY" == "true" ]] || [[ "$SYSTEM_TYPE" != "darwin" ]]; then
        NH_ARGS=("home" "switch" "." "-c" "$HOST")
    elif [[ "$SYSTEM_TYPE" == "darwin" ]]; then
        NH_ARGS=("darwin" "switch" ".#darwinConfigurations.$HOST")
    fi

    if [[ "$ASK_FLAG" == "true" ]]; then
        NH_ARGS+=("--ask")
    fi

    export NH_FLAKE="$SCRIPT_DIR"
    if nh "${NH_ARGS[@]}" -- "${EXTRA_ARGS[@]}"; then
        print_success "Configuration rebuilt successfully with nh!"
    else
        print_error "Rebuild with nh failed!"
        exit 1
    fi
else
    if [[ "$ASK_FLAG" == "true" ]]; then
        print_warning "--ask flag requires nh, falling back to native tools without preview"
    fi

    if [[ "$HOME_ONLY" == "true" ]]; then
        print_info "Using home-manager..."

        HM_ARGS=(
            "switch"
            "--flake" ".#$HOST"
            "-b" "backup"
        )
        if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
            HM_ARGS+=("${EXTRA_ARGS[@]}")
        fi
        if home-manager "${HM_ARGS[@]}"; then
            print_success "Home Manager configuration rebuilt successfully!"

            if ! command -v nh &> /dev/null; then
                echo ""
                print_info "Tip: Consider installing nh for better rebuild UX with diffs and --ask flag"
            fi
        else
            print_error "Home Manager rebuild failed!"
            exit 1
        fi
    elif [[ "$SYSTEM_TYPE" == "darwin" ]]; then
        DARWIN_ARGS=(
            "switch"
            "--flake" ".#$HOST"
        )

        if command -v darwin-rebuild &> /dev/null; then
            print_info "Using darwin-rebuild..."
            DARWIN_CMD=(
                sudo
                env
                "NIX_CONFIG=$NIX_CONFIG"
                darwin-rebuild
            )
        else
            print_info "darwin-rebuild not found, bootstrapping via nix run..."
            DARWIN_CMD=(
                sudo
                env
                "NIX_CONFIG=$NIX_CONFIG"
                nix
                "run"
                "nix-darwin/master#darwin-rebuild"
                "--"
            )
        fi

        if "${DARWIN_CMD[@]}" "${DARWIN_ARGS[@]}" "${EXTRA_ARGS[@]}"; then
            print_success "Darwin configuration rebuilt successfully!"

            if ! command -v nh &> /dev/null; then
                echo ""
                print_info "Tip: nh has been added to your packages but requires a rebuild to activate"
                echo "      After this rebuild, you'll get nice diffs and an --ask flag!"
            fi
        else
            print_error "Darwin rebuild failed!"
            exit 1
        fi
    else
        print_info "Using home-manager..."

        HM_ARGS=(
            "switch"
            "--flake" ".#$HOST"
            "-b" "backup"
        )
        if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
            HM_ARGS+=("${EXTRA_ARGS[@]}")
        fi
        if home-manager "${HM_ARGS[@]}"; then
            print_success "Home Manager configuration rebuilt successfully!"

            if ! command -v nh &> /dev/null; then
                echo ""
                print_info "Tip: Consider installing nh for better rebuild UX with diffs and --ask flag"
            fi
        else
            print_error "Home Manager rebuild failed!"
            exit 1
        fi
    fi
fi
