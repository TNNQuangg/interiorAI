import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createProceduralFurniture } from './proceduralFurniture'

describe('bench geometry', () => {
  it.each([false, true])('has a seat and four legs within canonical dimensions (low spec %s)', (lowSpecMode) => {
    const pickableMeshes: THREE.Object3D[] = []
    const bench = createProceduralFurniture({
      category: 'bench', entityId: 'bench_atl15_japandi',
      width: 1.2, depth: 0.4, height: 0.45, color: '#D5CBBF',
      pickableMeshes, lowSpecMode,
    })
    const bounds = new THREE.Box3().setFromObject(bench)
    const size = bounds.getSize(new THREE.Vector3())
    expect(size.x).toBeCloseTo(1.2)
    expect(size.y).toBeCloseTo(0.45)
    expect(size.z).toBeCloseTo(0.4)
    expect(bounds.min.y).toBeCloseTo(0)
    expect(bench.children).toHaveLength(6)
    expect(pickableMeshes).toHaveLength(6)
    expect(pickableMeshes.every(mesh => mesh.userData.entityId === 'bench_atl15_japandi')).toBe(true)
    bench.traverse(node => {
      if (node instanceof THREE.Mesh) {
        node.geometry.dispose()
        const materials = Array.isArray(node.material) ? node.material : [node.material]
        materials.forEach(material => material.dispose())
      }
    })
  })
})
