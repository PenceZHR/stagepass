/*
 * three.js 冒烟：真起一个 WebGLRenderer、画一帧、把像素读回来。
 * 图谱那两屏是懒加载的（没数据就不建场景），所以不能靠「有没有 canvas」判断
 * three 在这个沙箱里活不活 —— 这里直接问它。
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const R = (window.__SP_REPORT__ = window.__SP_REPORT__ || {});
try {
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:-9999px;width:64px;height:64px";
  document.body.appendChild(box);

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setSize(64, 64);
  box.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 3;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xf0c674 }),
  );
  scene.add(mesh);
  renderer.render(scene, camera);

  const pixels = new Uint8Array(4);
  const gl = renderer.getContext();
  gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  new OrbitControls(camera, renderer.domElement).dispose();
  new CSS2DRenderer().setSize(64, 64);

  R.three = {
    version: THREE.REVISION,
    ctx: renderer.getContext() ? "有" : "无",
    centerPixel: Array.from(pixels).join(","),
    drew: pixels[0] > 200 && pixels[1] > 150 ? "✓ 画出来了" : "✗ 中心是空的",
    addons: "OrbitControls + CSS2DRenderer 都构造成功",
  };
  renderer.dispose();
  box.remove();
} catch (error) {
  R.three = { error: String(error && error.message || error).slice(0, 200) };
}
