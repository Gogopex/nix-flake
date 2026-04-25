{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  inherit (lib)
    attrValues
    mkOption
    types
    ;

  corePackages = {
    inherit (pkgs)
      bandwhich
      zoxide
      fzf
      ripgrep
      bat
      fd
      eza
      git
      curl
      wget
      broot

      zellij
      delta

      nixfmt-rfc-style
      nixd
      nh

      tokei
      hyperfine
      just
      cmake
      ninja
      tldr
      glow
      lazygit
      procs
      jq
      yq-go
      tree
      bottom
      sd

      dust
      uutils-coreutils-noprefix

      gh
      ;

    agenix = inputs.agenix.packages.${pkgs.stdenv.hostPlatform.system}.default;
    dispatch = inputs.dispatch.packages.${pkgs.stdenv.hostPlatform.system}.default;
    recall = inputs.recall.packages.${pkgs.stdenv.hostPlatform.system}.default;
  };

  fullPackages = corePackages // {
    inherit (pkgs)
      # go
      # gopls
      # gofumpt
      # delve

      rustup
      lldb

      swift
      sourcekit-lsp
      swift-format

      nodejs_24
      bun
      deno
      vscode-js-debug

      python311
      poetry
      uv
      ty
      ruff
      # black

      # ghc
      # cabal-install
      # haskell-language-server
      # ormolu
      # fourmolu
      # stylish-haskell

      # maven
      # openjdk
      # jdt-language-server
      # google-java-format

      volta

      lsp-ai
      mutagen

      ffmpeg
      imagemagick
      pandoc
      graphviz

      # postgresql
      # redis
      sqlite
      duckdb

      git-recent
      radicle-node

      wiki-tui
      tailscale

      vault
      argocd

      ast-grep
      ;
  };

  profilePackages = if config.packages.profile == "full" then fullPackages else corePackages;

in
{
  options = {
    packages.profile = mkOption {
      type = types.enum [
        "core"
        "full"
      ];
      default = "core";
    };
  };

  config = {
    home-manager.sharedModules = [
      {
        home.packages = attrValues profilePackages;

        programs.zoxide.enable = true;

        programs.direnv = {
          enable = true;
          package = pkgs.direnv.overrideAttrs {
            doCheck = false;
          };
          nix-direnv.enable = true;
        };

        programs.btop = {
          enable = true;
          settings = {
            vim_keys = true;
            rounded_corners = true;
          };
        };
      }
    ];
  };
}
