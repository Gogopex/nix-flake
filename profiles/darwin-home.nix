{
  config,
  lib,
  inputs,
  pkgs,
  ...
}:
let
  libWithExtensions = lib // (import ../lib inputs lib lib);
  hmLib = inputs.home-manager.lib;
  modulePaths = (lib.collectNix ../modules/common) ++ (lib.collectNix ../modules/darwin);

  filteredModulePaths = lib.filter (path: builtins.baseNameOf path != "home-manager.nix") modulePaths;

  hmEval = libWithExtensions.evalModules {
    modules = filteredModulePaths ++ [
      {
        config._module.check = false;
      }
    ];
    specialArgs = {
      inherit inputs pkgs;
    };
  };

  sharedModules = hmEval.config.home-manager.sharedModules or [ ];
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

  nixConfig.manage = false;

  home.stateVersion = "24.05";
  programs.home-manager.enable = true;
  manual.manpages.enable = false;
  manual.html.enable = false;
  manual.json.enable = false;

  home.sessionVariables = {
    SPECTER_ARTIFACT_ROOT = "/Users/ludwig/mnt/specter-archive";
    SPECTER_JJ_WS_ROOT = "/Users/ludwig/ws/specter-labs";
    SPECTER_LOG_ROOT = "/Users/ludwig/mnt/specter-archive";
  };

  home.activation.specterArchiveMountpoint = hmLib.hm.dag.entryAfter [ "writeBoundary" ] ''
    mkdir -p "$HOME/mnt/specter-archive"
  '';

  programs.fish.functions.specter_mount = ''
    function specter_mount
      set -l mountpoint "$HOME/mnt/specter-archive"
      mkdir -p $mountpoint

      if mount | string match -q "* on $mountpoint *"
        echo "$mountpoint already mounted"
        return 0
      end

      /sbin/mount_smbfs -N //u541484-sub1@u541484-sub1.your-storagebox.de/u541484-sub1 $mountpoint
    end
  '';
}
