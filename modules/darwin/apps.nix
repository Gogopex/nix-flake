{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkIf;
in
{
  config = mkIf config.isDesktop {
    # nix-darwin copies applications from environment.systemPackages into
    # /Applications/Nix Apps as real bundles so LaunchServices/Spotlight see them.
    environment.systemPackages = with pkgs; [
      maccy
      obsidian
      zotero
    ];
  };
}
