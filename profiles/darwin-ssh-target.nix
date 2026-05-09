{
  config,
  pkgs,
  ...
}:
{
  type = "server";

  nixpkgs.hostPlatform = "aarch64-darwin";

  nix.enable = false;
  nixConfig.manage = false;

  user.name = "ludwigpouey";
  userShell = "fish";
  system.primaryUser = "ludwigpouey";
  system.stateVersion = 6;

  packages.profile = "thin";

  users.users.ludwigpouey = {
    name = "ludwigpouey";
    home = "/Users/ludwigpouey";
    shell = if config.userShell == "nushell" then pkgs.nushell else pkgs.fish;
  };

  home-manager.users.ludwigpouey.home = {
    stateVersion = "24.05";
    homeDirectory = "/Users/ludwigpouey";
  };

  environment.systemPackages = with pkgs; [
    git
    fish
    grc
  ];

  environment.pathsToLink = [
    "/share/zsh"
    "/share/fish"
  ];

  programs.fish.enable = true;
  environment.shells = [ pkgs.fish ];

  age.identityPaths = [
    "/Users/ludwigpouey/.ssh/id_ed25519"
  ];

  system.defaults = {
    NSGlobalDomain = {
      ApplePressAndHoldEnabled = false;
      InitialKeyRepeat = 15;
      KeyRepeat = 2;
    };

    screencapture = {
      location = "~/Pictures/Screenshots";
      type = "png";
      disable-shadow = false;
      include-date = true;
      show-thumbnail = true;
      target = "file";
    };
  };

  system.keyboard = {
    enableKeyMapping = true;
    remapCapsLockToControl = true;
  };
}
