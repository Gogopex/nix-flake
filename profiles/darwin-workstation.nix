{
  pkgs,
  config,
  ...
}:
let
  disabledSymbolicHotKey = keyCode: modifiers: {
    enabled = false;
    value = {
      parameters = [
        65535
        keyCode
        modifiers
      ];
      type = "standard";
    };
  };
in
{
  type = "desktop";

  nixpkgs.hostPlatform = "aarch64-darwin";

  nix.enable = false;
  nixConfig.manage = false;

  userShell = "fish";
  system.primaryUser = "ludwig";
  system.stateVersion = 6;

  packages.profile = "full";

  darwin.windowManagers.rectangle.enable = true;
  darwin.hammerspoon.enable = true;

  users.users.ludwig = {
    name = "ludwig";
    home = "/Users/ludwig";
    shell = if config.userShell == "nushell" then pkgs.nushell else pkgs.fish;
  };

  home-manager.users.ludwig.home = {
    stateVersion = "24.05";
    homeDirectory = "/Users/ludwig";
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

  homebrew = {
    enable = true;
    global.brewfile = true;
    onActivation.cleanup = "uninstall";

    taps = [
      "shivammathur/php"
    ];

    casks = [
      "hyperkey"
      "orbstack"
      "sublime-text"
      "superwhisper"
      "zed"
    ];

    brews = [
      "protobuf"
      "buf"
      "shivammathur/php/php"
      # "shivammathur/php/php@8.2"
      "shivammathur/php/php@8.3"
      "composer"
    ];
  };

  environment.systemPath = [ "/opt/homebrew/bin" ];

  age.secrets = {
    anthropic-api-key = {
      file = ../secrets/anthropic-api-key.age;
      mode = "444";
    };
    openai-api-key = {
      file = ../secrets/openai-api-key.age;
      mode = "444";
    };
    gemini-api-key = {
      file = ../secrets/gemini-api-key.age;
      mode = "444";
    };
    deepseek-api-key = {
      file = ../secrets/deepseek-api-key.age;
      mode = "444";
    };
    gemini-api-gcp-project-id = {
      file = ../secrets/gemini-api-gcp-project-id.age;
      mode = "444";
    };
    openrouter-api-key = {
      file = ../secrets/openrouter-api-key.age;
      mode = "444";
    };
    groq-api-key = {
      file = ../secrets/groq-api-key.age;
      mode = "444";
    };
    glm-api-key = {
      file = ../secrets/glm-api-key.age;
      mode = "444";
    };
    kimi-api-key = {
      file = ../secrets/kimi-api-key.age;
      mode = "444";
    };
    zai-api-key = {
      file = ../secrets/zai-api-key.age;
      mode = "444";
    };
    github-token = {
      file = ../secrets/github-token.age;
      mode = "444";
    };
  };

  system.defaults = {
    NSGlobalDomain = {
      ApplePressAndHoldEnabled = false;
      InitialKeyRepeat = 15;
      KeyRepeat = 2;
    };

    dock = {
      autohide = true;
      show-process-indicators = true;
      tilesize = 48;
    };

    screencapture = {
      location = "~/Pictures/Screenshots";
      type = "png";
      disable-shadow = false;
      include-date = true;
      show-thumbnail = true;
      target = "file";
    };

    CustomUserPreferences = {
      "com.apple.symbolichotkeys" = {
        AppleSymbolicHotKeys = {
          "65" = disabledSymbolicHotKey 49 1572864;
        };
      };
      "com.kagi.orion" = {
        NSUserKeyEquivalents = {
          "Show Sidebar" = "@$s";
          "Hide Sidebar" = "@$s";
        };
      };
    };
  };

  system.keyboard = {
    enableKeyMapping = true;
    remapCapsLockToControl = true;
  };
}
