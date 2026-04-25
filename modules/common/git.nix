{ config, lib, ... }:
let
  inherit (lib) enabled merge;
in
merge {
  home-manager.sharedModules = [
    (
      homeArgs:
      let
        homeConfig = homeArgs.config;
      in
      {
        programs.git = enabled {
          settings = {
            user = {
              name = config.user.name;
              email = config.user.email;
            };

            pull.rebase = false;
            init.defaultBranch = "main";
            push.autoSetupRemote = true;
            signing.format = "openpgp";
            merge.conflictStyle = "zdiff3";
            rebase.autosquash = true;
            diff.colorMoved = "default";

            core.pager = "delta";
            interactive.diffFilter = "delta --color-only";
            delta = {
              navigate = true;
              light = false;
              line-numbers = true;
              side-by-side = false;
              syntax-theme = "gruvbox-dark";
            };

            alias = {
              st = "status";
              co = "checkout";
              br = "branch";
              last = "log -1 HEAD";

              l = "log --oneline --graph --decorate";
              la = "log --oneline --graph --decorate --all";

              d = "diff";
              dc = "diff --cached";

              a = "add";
              c = "commit";
              ca = "commit -a";

              unstage = "reset HEAD --";

              visual = "!gitk";
            };
          };
        };
      }
    )
  ];
}
