{
  lib,
  pkgs,
  config,
  ...
}:
let
  inherit (lib)
    enabled
    merge
    mkIf
    mkOption
    types
    ;
  isFish = config.userShell == "fish";
in
{
  options.userShell = mkOption {
    type = types.enum [
      "fish"
      "nushell"
    ];
    default = "fish";
  };

  config = mkIf isFish (merge {
    home-manager.sharedModules = [
      {
        programs.fish = enabled {
          shellAliases = {
            ll = "ls -alh";
            lt = "eza -la --group-directories-first --time-style=long-iso --binary --header --icons=never --no-user --no-permissions";
            ltg = "eza -la --group-directories-first --sort=modified --time-style=long-iso --git --binary --header --icons=never --no-user --no-permissions";

            lt1 = "eza -T -L 1 -a --group-directories-first --icons=never";
            lt1g = "eza -T -L 1 -a --group-directories-first --git --icons=never";
            ingest = "~/go/bin/ingest";
            cat = "bat";
            ps = "procs";
            du = "dust";
            top = "btop";
            help = "tldr";
            md = "glow";
            lg = "lazygit";
            bench = "hyperfine";
            vim-mode = "toggle_vim_mode";
            links = "open_links";
            zls = "zellij list-sessions";
            zdel = "zellij delete-session";
            zforce = "zellij attach --force-run-commands";
            bre = "$HOME/.cargo/bin/br";
          };

          shellInit = # fish
            ''
              function __dotfiles_has_addenda_mount
                command mount | string match -q '* on /Volumes/Addenda *'
              end

              function __dotfiles_cache_root
                if __dotfiles_has_addenda_mount
                  echo /Volumes/Addenda/caches
                else
                  echo $HOME/.cache
                end
              end

              set -gx VOLTA_HOME $HOME/.volta
              set -gx VOLTA_FEATURE_PNPM 1
              fish_add_path -g -m -p $VOLTA_HOME/bin

              if status is-interactive
                fish_add_path -g -m -p ~/.local/bin
                fish_add_path -g /opt/homebrew/bin
                fish_add_path -g ~/.nix-profile/bin
                fish_add_path -g /etc/profiles/per-user/${config.user.name}/bin
                fish_add_path -g /run/current-system/sw/bin
                fish_add_path -g /nix/var/nix/profiles/default/bin
                fish_add_path ~/.cargo/bin
                set -l cache_root (__dotfiles_cache_root)
                if test -d $cache_root/cargo/bin
                  fish_add_path $cache_root/cargo/bin
                end
                fish_add_path ~/go/bin
                fish_add_path ~/.modular/bin \
                               /Applications/WezTerm.app/Contents/MacOS \
                               $HOME/.cache/lm-studio/bin
                fish_add_path ~/dev/google-cloud-sdk/bin
              end

              for key in anthropic openai gemini deepseek openrouter groq glm kimi zai
                if test -f /run/agenix/$key-api-key
                  set -gx (string upper $key)_API_KEY (command cat /run/agenix/$key-api-key)
                end
              end

              if test -f /run/agenix/gemini-api-gcp-project-id
                set -gx GOOGLE_CLOUD_PROJECT (command cat /run/agenix/gemini-api-gcp-project-id)
              end

              if test -f /run/agenix/github-token
                set -l gh_token (command cat /run/agenix/github-token | string trim)
                set -gx GITHUB_TOKEN $gh_token
                if not set -q NIX_CONFIG
                  set -gx NIX_CONFIG "access-tokens = github.com=$gh_token"
                else if not string match -q "*access-tokens = github.com=*" "$NIX_CONFIG"
                  set -gx NIX_CONFIG (printf "%s\n%s" "$NIX_CONFIG" "access-tokens = github.com=$gh_token")
                end
              end
            '';

          interactiveShellInit = # fish
            ''
              set -gx EDITOR ${config.user.editor}
              set -gx PHP_VERSION 8.3

              set -l cache_root (__dotfiles_cache_root)
              set -gx CARGO_HOME $cache_root/cargo
              set -gx GOMODCACHE $cache_root/go-mod
              set -gx UV_CACHE_DIR $cache_root/uv
              set -gx NPM_CONFIG_CACHE $cache_root/npm
              set -gx NPM_CONFIG_PREFIX $HOME/.local
              set -gx PIP_CACHE_DIR $cache_root/pip
              set -gx HOMEBREW_CACHE $cache_root/homebrew
              set -gx HF_HOME $cache_root/huggingface
              fish_add_path -g -m -p $NPM_CONFIG_PREFIX/bin

              fish_vi_key_bindings
              setup_enhanced_vi_mode

              set -g hydro_multiline false
              set -g hydro_prompt_show_user false
              set -g hydro_prompt_show_host false

              if set -q GHOSTTY_RESOURCES_DIR
                source $GHOSTTY_RESOURCES_DIR/shell-integration/fish/vendor_conf.d/ghostty-shell-integration.fish
              end
              zoxide init fish | source
              if test -f ~/.orbstack/shell/init2.fish
                source ~/.orbstack/shell/init2.fish 2>/dev/null
              end

              function fish_user_key_bindings
                if functions -q fzf_configure_bindings
                  fzf_configure_bindings
                end
                bind \e\cv 'toggle_vim_mode'
                bind \e\cl 'open_links'
                bind \e\cb 'br; commandline -f repaint'

                bind \c\; 'toggle_vim_mode'
              end

              fish_user_key_bindings

            '';

          functions = {
            fish_greeting = ''echo "What is impossible for you is not impossible for me."'';

            copy_to_clipboard = ''
              if type -q pbcopy
                cat | pbcopy
              else if type -q wl-copy
                cat | wl-copy
              else if type -q xclip
                cat | xclip -selection clipboard
              else if type -q xsel
                cat | xsel --clipboard --input
              else
                echo "No clipboard command available (tried pbcopy, wl-copy, xclip, xsel)" >&2
                return 127
              end
            '';
            cc = ''
              if test (count $argv) -eq 0
                echo "Usage: cc <command> [args...]" >&2
                return 2
              end

              $argv | copy_to_clipboard
            '';
            pi = ''
              if not command -q pi
                echo "pi not found. It should be installed by Volta; run ./rebuild.sh if missing." >&2
                return 127
              end

              command pi $argv
            '';
            hq = ''
              set -l hermes_args (string join " " -- (string escape -- $argv))
              ssh -t quietbox "export PATH=\"\$HOME/.local/bin:\$PATH\"; export COLORTERM=truecolor TERM_PROGRAM=ghostty; exec hermes $hermes_args"
            '';
            fish_mode_prompt = ''
              switch $fish_bind_mode
                case default
                  set_color -o brgreen
                  echo -n "◆ "
                  set_color normal
                case insert
                  set_color -o bryellow
                  echo -n "◇ "
                  set_color normal
                case replace_one
                  set_color -o brred
                  echo -n "◈ "
                  set_color normal
                case replace
                  set_color -o brred
                  echo -n "▓ "
                  set_color normal
                case visual
                  set_color -o brmagenta
                  echo -n "◉ "
                  set_color normal
              end
            '';

            nix_shell_prompt = ''
              if test -n "$IN_NIX_SHELL"
                set_color -o brcyan
                echo -n "☼"
                set_color normal
              end
            '';

            fish_right_prompt = ''
              nix_shell_prompt
            '';

            setup_enhanced_vi_mode = ''
              set -g fish_cursor_default block
              set -g fish_cursor_insert line
              set -g fish_cursor_replace_one underscore
              set -g fish_cursor_replace underscore
              set -g fish_cursor_external line
              set -g fish_cursor_visual block

              bind -M default V 'commandline -f beginning-of-line visual-mode end-of-line'

              bind -M default gh 'commandline -f beginning-of-line'
              bind -M default gl 'commandline -f end-of-line'
              bind -M default 0 'commandline -f beginning-of-line'
              bind -M default '$' 'commandline -f end-of-line'

              bind -M default gg 'commandline -f beginning-of-buffer'
              bind -M default G 'commandline -f end-of-buffer'

              bind -M visual gh 'commandline -f beginning-of-line'
              bind -M visual gl 'commandline -f end-of-line'
              bind -M visual 0 'commandline -f beginning-of-line'
              bind -M visual '$' 'commandline -f end-of-line'
              bind -M visual gg 'commandline -f beginning-of-buffer'
              bind -M visual G 'commandline -f end-of-buffer'
            '';

            toggle_vim_mode = ''
              if test "$fish_key_bindings" = "fish_vi_key_bindings"
                echo "Switching to default key bindings"
                fish_default_key_bindings
                set -g fish_key_bindings fish_default_key_bindings
              else
                echo "Switching to enhanced vim key bindings"
                fish_vi_key_bindings
                setup_enhanced_vi_mode
                set -g fish_key_bindings fish_vi_key_bindings
              end
            '';

            open_links = ''
              # Usage: links [LINES]
              set -l limit 400
              if test (count $argv) -gt 0
                if string match -rq '^[0-9]+$' -- $argv[1]
                  set limit $argv[1]
                end
              end
              set -l temp_file (mktemp)
              set -l source_desc ""

              if set -q ZELLIJ
                if not zellij action dump-screen $temp_file
                  echo "Error: Failed to dump Zellij screen"
                  rm -f $temp_file
                  return 1
                end
                command tail -n $limit $temp_file > $temp_file.tmp; and mv $temp_file.tmp $temp_file
                set source_desc "Zellij pane"
              else if set -q TMUX
                if not tmux capture-pane -p -S -$limit > $temp_file
                  echo "Error: Failed to capture tmux pane"
                  rm -f $temp_file
                  return 1
                end
                set source_desc "tmux pane"
              else
                history | head -n $limit > $temp_file
                set source_desc "command history (fallback)"
              end

              set -l all_urls

              set -l standard_urls (command cat $temp_file | \
                rg -o -i '\b(https?|ftp|file)://[-A-Za-z0-9+&@#/%?=~_|!:,.;]*[-A-Za-z0-9+&@#/%=~_|]' | \
                string collect)

              set -l markdown_urls (command cat $temp_file | \
                rg -o '\[([^\]]+)\]\(([^)]+)\)' -r '$2' | \
                string match -r '^https?://.*')

              set -l bare_domains (command cat $temp_file | \
                rg -o '\b([a-zA-Z0-9][-a-zA-Z0-9]*\.)+[a-zA-Z]{2,}\b(/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|])?' | \
                string match -r -v '^(com|org|net|edu|gov|mil|int|example|test|localhost|invalid)$' | \
                string replace -r '^' 'https://')

              for url in $standard_urls $markdown_urls $bare_domains
                set all_urls $all_urls $url
              end

              set -l clean_urls
              for url in $all_urls
                # Remove trailing punctuation but keep it if it's part of the URL structure
                set -l cleaned (echo $url | string replace -r "([),;:!?\\.\"']+)$" "" | string trim)

                # Validate URL has a valid structure
                if string match -q -r '^(https?|ftp|file)://[^/]+' $cleaned
                  set clean_urls $clean_urls $cleaned
                end
              end

              set -l urls (printf '%s\n' $clean_urls | sort -u)

              # Clean up temp file
              rm -f $temp_file

              if test (count $urls) -eq 0
                echo "No URLs found in $source_desc"
                return 1
              end

              echo "Found "(count $urls)" URL(s) from $source_desc"
              set -l selected (printf '%s\n' $urls | \
                fzf --prompt="Select URL to open: " \
                    --preview-window=hidden \
                    --height=40%)

              if test -n "$selected"
                echo "Opening: $selected"
                if type -q open
                  open "$selected"
                else if type -q xdg-open
                  xdg-open "$selected" >/dev/null 2>&1 &
                else
                  echo "No URL opener found (tried open, xdg-open)" >&2
                  return 127
                end
              end
            '';

            br = ''
              set -l cmd_file (mktemp)
              if broot --outcmd $cmd_file $argv
                set -l cmd (command cat $cmd_file)
                rm -f $cmd_file
                eval $cmd
              else
                set -l exit_code $status
                rm -f $cmd_file
                return $exit_code
              end
            '';

            zellij = ''
              if set -q SSH_CLIENT
                set -l client_ip (string split ' ' $SSH_CLIENT)[1]
                if test "$client_ip" = "100.75.162.114"
                  command zellij --config ~/.config/zellij/config-ssh.kdl $argv
                  return
                end
              end
              command zellij $argv
            '';

          };

          plugins = [
            {
              name = "grc";
              src = pkgs.fishPlugins.grc.src;
            }
            {
              name = "hydro";
              src = pkgs.fishPlugins.hydro.src;
            }
            {
              name = "gruvbox";
              src = pkgs.fishPlugins.gruvbox.src;
            }
            {
              name = "fzf-fish";
              src = pkgs.fishPlugins.fzf-fish.src;
            }
          ];
        };
      }
    ];
  });
}
