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

    // X25519 for PQ sessions uses the same pinned, prepared libsodium 1.0.22
    // input as c-toxcore. Link its static archive directly because toxcore does
    // not export libsodium's public crypto_scalarmult symbols.
    let sodium_lib_dir = env::var_os("KAIGEN_LIBSODIUM_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if target_os == "windows" {
                project_dir.join("work/deps/libsodium/libsodium/x64/Release/v143/static")
            } else {
                project_dir
                    .join("work")
                    .join("platform")
                    .join(&target_os)
                    .join("libsodium")
                    .join("lib")
            }
        });
    println!("cargo:rerun-if-env-changed=KAIGEN_LIBSODIUM_LIB_DIR");
    println!(
        "cargo:rustc-link-search=native={}",
        sodium_lib_dir.display()
    );
    // MSVC's archive is libsodium.lib; Unix prep installs libsodium.a,
    // whose linker name excludes the conventional `lib` prefix.
    if target_os == "windows" {
        println!("cargo:rustc-link-lib=static=libsodium");
        // libsodium's Windows system RNG calls SystemFunction036.
        println!("cargo:rustc-link-lib=dylib=advapi32");
    } else {
        println!("cargo:rustc-link-lib=static=sodium");
    }

    if target_os == "windows" {
        let out_dir = PathBuf::from(env::var("OUT_DIR").expect("Cargo output directory"));
        // OUT_DIR always lives at <actual Cargo target>/<profile>/build/<crate>/out.
        // Deriving from it also works when Kaigen is a path dependency of
        // kaigen-webd, where CARGO_TARGET_DIR is not forwarded to build.rs.
        let target_dir = out_dir
            .ancestors()
            .nth(3)
            .expect("Cargo profile output directory")
            .to_path_buf();
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

    // mlkem-native 2.0.0 is vendored from the verified upstream source archive. Build its
    // portable C backend so no development runtime or crypto DLL is required
    // on the destination PC.
    let mlkem_root = project_dir.join("vendor/mlkem-native-2.0.0/mlkem");
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
        // Keep mlkem-native's consumer-supplied RNG callback distinct from
        // libsodium's public randombytes symbol when both static archives are
        // linked into Kaigen.
        .define("randombytes", "kaigen_mlkem_randombytes")
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

    #[cfg(feature = "desktop")]
    tauri_build::build()
}
