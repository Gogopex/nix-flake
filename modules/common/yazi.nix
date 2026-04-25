{ lib, ... }:
let
  inherit (lib) copyToClipboardShell enabled merge;
in
merge {
  home-manager.sharedModules = [
    {
      programs.yazi = enabled {
        enableFishIntegration = true;
        shellWrapperName = "yy";

        settings = {
          log = {
            enabled = false;
          };
          mgr = {
            show_hidden = true;
            sort_by = "mtime";
          };
        };

        keymap = {
          normal = {
            "." = "shell '${copyToClipboardShell}; printf \"%s\" \"$0\" | copy_to_clipboard' --confirm";
            "ctrl-c" = "quit";
            "C-Space" = "toggle_preview";
          };
        };
      };
    }
  ];
}
