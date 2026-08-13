use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let project_dir = manifest_dir.parent().expect("project directory");
    let target_os = env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS");
    let tox_build_dir = if target_os == "windows" {
        project_dir.join("work/build/toxcore-native-windows")
    } else {
        env::var_os("KAIGEN_TOXCORE_LIB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                project_dir
                    .join("work")
                    .join("platform")
                    .join(&target_os)
                    .join("toxcore")
                    .join("lib")
            })
    };
    println!("cargo:rerun-if-env-changed=KAIGEN_TOXCORE_LIB_DIR");
    println!("cargo:rustc-link-search=native={}", tox_build_dir.display());
    println!("cargo:rustc-link-lib=dylib=toxcore");

    if target_os == "windows" {
        let profile = env::var("PROFILE").expect("Cargo profile");
        let cargo_target_dir = env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| manifest_dir.join("target"));
        let target_dir = cargo_target_dir.join(profile);
        fs::create_dir_all(&target_dir).expect("create Cargo target directory");

        let native_runtimes = [
            tox_build_dir.join("toxcore.dll"),
            project_dir.join("work/deps/pthreads4w-dynamic/pthreadVC3.dll"),
        ];
        for source in native_runtimes {
            let file_name = source.file_name().expect("native runtime file name");
            for destination in [
                target_dir.join(file_name),
                target_dir.join("deps").join(file_name),
            ] {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent).expect("create native runtime directory");
                }
                fs::copy(&source, &destination).unwrap_or_else(|error| {
                    panic!(
                        "copy {} to {}: {error}",
                        source.display(),
                        destination.display()
                    )
                });
            }
            println!("cargo:rerun-if-changed={}", source.display());
        }
    } else if target_os == "linux" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/Kaigen");
    } else if target_os == "macos" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }

    // mlkem-native 1.3.0 is vendored with the source archive.  Build its
    // portable C backend so no development runtime or crypto DLL is required
    // on the destination PC.
    let mlkem_root = project_dir.join("vendor/mlkem-native-1.3.0/mlkem");
    let mlkem_src = mlkem_root.join("src");
    let fips202_src = mlkem_src.join("fips202");
    let mut mlkem_build = cc::Build::new();
    mlkem_build
        .include(&mlkem_root)
        .include(&mlkem_src)
        .include(&fips202_src)
        .include(fips202_src.join("native"))
        .include(mlkem_src.join("sys"))
        .include(mlkem_src.join("native"))
        .define("MLK_CONFIG_PARAMETER_SET", "768")
        .warnings(false);
    for directory in [&mlkem_src, &fips202_src] {
        for entry in fs::read_dir(directory).expect("read mlkem-native source directory") {
            let path = entry.expect("read mlkem-native source entry").path();
            if path.extension().and_then(|value| value.to_str()) == Some("c") {
                mlkem_build.file(path);
            }
        }
    }
    mlkem_build.compile("mlkem_native_768");
    println!("cargo:rerun-if-changed={}", mlkem_root.display());

    tauri_build::build()
}
