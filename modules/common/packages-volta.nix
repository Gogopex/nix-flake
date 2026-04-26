{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  inherit (lib) concatMapStringsSep escapeShellArg optionalAttrs;
  hmLib = inputs.home-manager.lib.hm;
  defaultNodeVersion = "24.14.1";
  defaultNpmVersion = "11.6.2";
  defaultYarnVersion = "1.22.22";
  defaultPnpmVersion = "9.15.4";
  homeDirectory =
    if config.isDarwin then "/Users/${config.user.name}" else "/home/${config.user.name}";
  voltaHome = "${homeDirectory}/.volta";

  voltaToolchain = [
    {
      expected = "runtime node@${defaultNodeVersion} (default)";
      spec = "node@${defaultNodeVersion}";
    }
    {
      expected = "package-manager npm@${defaultNpmVersion}";
      spec = "npm@${defaultNpmVersion}";
    }
    {
      expected = "package-manager yarn@${defaultYarnVersion}";
      spec = "yarn@${defaultYarnVersion}";
    }
    {
      expected = "package-manager pnpm@${defaultPnpmVersion}";
      spec = "pnpm@${defaultPnpmVersion}";
    }
  ];

  voltaPackages = [
    {
      expected = "package typescript@5.9.3";
      spec = "typescript@5.9.3";
    }
    {
      expected = "package typescript-language-server@5.1.3";
      spec = "typescript-language-server@5.1.3";
    }
    {
      expected = "package prettier@3.6.2";
      spec = "prettier@3.6.2";
    }
    {
      expected = "package vscode-langservers-extracted@4.10.0";
      spec = "vscode-langservers-extracted@4.10.0";
    }
    {
      expected = "package yaml-language-server@1.19.2";
      spec = "yaml-language-server@1.19.2";
    }
    {
      expected = "package @biomejs/biome@2.3.9";
      spec = "@biomejs/biome@2.3.9";
    }
    {
      expected = "package @mariozechner/pi-coding-agent@0.70.2";
      spec = "@mariozechner/pi-coding-agent@0.70.2";
    }
  ];

  installVoltaTools = concatMapStringsSep "\n" (
    tool: "            ensure_volta_tool ${escapeShellArg tool.expected} ${escapeShellArg tool.spec}"
  ) (voltaToolchain ++ voltaPackages);
in
{
  config = {
    home-manager.sharedModules = [
      {
        home.sessionPath = [ "${voltaHome}/bin" ];
        home.sessionVariables = {
          VOLTA_HOME = voltaHome;
          VOLTA_FEATURE_PNPM = "1";
        }
        // optionalAttrs config.isDarwin {
          CGO_LDFLAGS = "-L${pkgs.darwin.libresolv}/lib";
        };

        home.activation.voltaToolchain = hmLib.dag.entryAfter [ "writeBoundary" ] ''
                    volta_bin="${pkgs.volta}/bin/volta"
                    export VOLTA_HOME="${voltaHome}"
                    export VOLTA_FEATURE_PNPM=1
                    export PATH="${pkgs.volta}/bin:$VOLTA_HOME/bin:$PATH"

                    mkdir -p "$VOLTA_HOME/bin"

                    for tool in node npm npx; do
                      target="$VOLTA_HOME/bin/$tool"
                      if [ -f "$target" ] && ! [ -L "$target" ] && grep -q 'volta which' "$target"; then
                        rm -f "$target"
                      fi
                    done

                    volta_state="$("$volta_bin" list all 2>/dev/null || true)"

                    ensure_volta_tool() {
                      expected="$1"
                      spec="$2"

                      if printf '%s\n' "$volta_state" | grep -Fq "$expected"; then
                        return 0
                      fi

                      if [ -n "''${DRY_RUN:-}" ]; then
                        echo "$volta_bin install $spec"
                      else
                        "$volta_bin" install "$spec"
                        volta_state="$("$volta_bin" list all 2>/dev/null || true)"
                      fi
                    }

          ${installVoltaTools}
        '';
      }
    ];
  };
}
