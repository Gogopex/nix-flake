{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.darwin.hammerspoon;
in
{
  options.darwin.hammerspoon = {
    enable = mkEnableOption "Configure Hammerspoon automation tool";
    fastWorkspaceSwitch.enable = mkEnableOption "Install fast Darwin Spaces switching helper";
  };

  config = mkIf (cfg.enable && pkgs.stdenv.isDarwin) {
    homebrew.casks = [ "hammerspoon" ];
    environment.systemPackages = mkIf cfg.fastWorkspaceSwitch.enable [
      pkgs.fast-workspace-switch
    ];

    home-manager.sharedModules = [
      {
        home.file.".hammerspoon" = {
          source = ../../cfg/hammerspoon;
          recursive = true;
        };
      }
    ];
  };
}
