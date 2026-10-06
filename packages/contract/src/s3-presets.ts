/**
 * Object storage presets of an S3-signed origin (site-content-v1 needs
 * none: they only fill the form). Every listed service documents AWS
 * Signature Version 4 on its S3-compatible endpoint; `address` is the
 * endpoint with placeholders in angle brackets the operator replaces,
 * `region` an example of the signing region, `bucketInHost` that the
 * service wants the bucket in the host name (virtual-hosted style: the
 * origin address names the bucket and the Bucket field stays empty).
 * Huawei Cloud OBS is not listed: its documentation describes only its own
 * signature scheme.
 */
export const S3_PRESETS = [
  {
    id: "aws",
    address: "s3.<region>.amazonaws.com",
    region: "us-east-1",
    bucketInHost: false,
  },
  {
    id: "r2",
    address: "<account_id>.r2.cloudflarestorage.com",
    region: "auto",
    bucketInHost: false,
  },
  {
    id: "b2",
    address: "s3.<region>.backblazeb2.com",
    region: "us-west-004",
    bucketInHost: false,
  },
  { id: "minio", address: "<host>", region: "us-east-1", bucketInHost: false },
  {
    id: "oss",
    address: "<bucket>.s3.oss-<region>.aliyuncs.com",
    region: "cn-hangzhou",
    bucketInHost: true,
  },
  {
    id: "cos",
    address: "<bucket>-<appid>.cos.<region>.myqcloud.com",
    region: "ap-guangzhou",
    bucketInHost: true,
  },
  { id: "bos", address: "s3.<region>.bcebos.com", region: "bj", bucketInHost: false },
  { id: "kodo", address: "s3.<region>.qiniucs.com", region: "cn-east-1", bucketInHost: false },
] as const;

export type S3Preset = (typeof S3_PRESETS)[number];
