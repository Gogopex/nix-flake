{ config, lib, ... }:
let
  inherit (lib) enabled merge;
in
merge {
  home-manager.sharedModules = [
    {
      programs.jujutsu = enabled {
        settings = {
          user.name = config.user.name;
          user.email = config.user.email;

          ui.default-command = "log";
          ui.diff-editor = ":builtin";
          ui.diff-formatter = ":git";
          ui.graph.style = if config.theme.cornerRadius > 0 then "curved" else "square";
          ui.pager = "hunk pager";

          aliases = {
            ".." = [
              "edit"
              "@-"
            ];
            ",," = [
              "edit"
              "@+"
            ];
            tug = [
              "bookmark"
              "set"
              "main"
              "-r"
              "@-"
            ];
            ship = [
              "git"
              "push"
              "--bookmark"
              "main"
            ];
          };

          remotes.origin.auto-track-bookmarks = "glob:*";
        };
      };
    }
  ];
}
