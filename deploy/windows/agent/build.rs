use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_dir = PathBuf::from("../proto/v1");
    let proto_files = vec![proto_dir.join("rmm.proto")];

    prost_build::Config::new()
        .out_dir("src/proto")
        .compile_protos(&proto_files, &[proto_dir])?;

    println!("cargo:rerun-if-changed=../proto/v1/rmm.proto");
    Ok(())
}