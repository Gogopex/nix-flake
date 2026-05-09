{
  config,
  lib,
  pkgs,
  ...
}:
let
  sharedModules = lib.homeManagerSharedModules' {
    inherit pkgs;
    modulePaths = [ ../modules/common ];
    extraModules = [
      {
        type = "server";
        nixConfig.manage = false;
        packages.profile = "thin";
        userShell = "fish";
      }
    ];
  };
in
{
  imports = [
    ../modules/common/system.nix
    ../modules/common/user.nix
    ../modules/common/theme.nix
    ../modules/common/editors.nix
    ../modules/common/editor-settings.nix
    ../modules/common/nix-config.nix
  ]
  ++ sharedModules;

  type = "server";
  nixConfig.manage = false;

  home.stateVersion = "24.11";
  programs.home-manager.enable = true;
  manual.manpages.enable = false;
  manual.html.enable = false;
  manual.json.enable = false;

  home.sessionVariables = {
    EDITOR = config.user.editor;
  };

  programs.bash = {
    enable = true;
    initExtra = ''
      # If running interactively and fish exists, exec into it
      if [[ $- == *i* ]] && [ -z "$IN_FISH" ] && command -v fish &> /dev/null; then
        export IN_FISH=1
        exec fish
      fi
    '';
  };

  home.packages = with pkgs; [
    htop
    ncdu
    clang
    numactl
    openmpi
    radicle-node
    tailscale
    uv
  ];
}
