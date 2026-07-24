// Глобальные переменные редактора
const editor = {
  scene:null, camera:null, renderer:null, controls:null, dragControls:null,
  objects:[], spawns:[], bombSite:null,
  selectedObject:null, currentColor:'#8B7355'
};

function initEditor() {
  editor.scene = new THREE.Scene();
  editor.scene.background = new THREE.Color(0x222222);
  editor.camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
  editor.renderer = new THREE.WebGLRenderer({ antialias:true });
  editor.renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('editorCanvas').appendChild(editor.renderer.domElement);

  editor.controls = new THREE.OrbitControls(editor.camera, editor.renderer.domElement);
  editor.controls.enableDamping = true;
  editor.controls.target.set(0,1,0);
  editor.camera.position.set(10,10,10);
  editor.controls.update();

  editor.dragControls = new THREE.DragControls([], editor.camera, editor.renderer.domElement);
  editor.dragControls.addEventListener('dragstart', function(event) {
    editor.controls.enabled = false;
    selectObject(event.object);
  });
  editor.dragControls.addEventListener('drag', function(event) {
    updateEditorData(event.object);
  });
  editor.dragControls.addEventListener('dragend', function(event) {
    editor.controls.enabled = true;
  });

  editor.scene.add(new THREE.AmbientLight(0x404040));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(10,20,5);
  editor.scene.add(dirLight);
  const gridHelper = new THREE.GridHelper(20, 20, 0x888888, 0x444444);
  editor.scene.add(gridHelper);

  window.addEventListener('resize', () => {
    editor.camera.aspect = window.innerWidth/window.innerHeight;
    editor.camera.updateProjectionMatrix();
    editor.renderer.setSize(window.innerWidth, window.innerHeight);
  });

  function animate() {
    requestAnimationFrame(animate);
    if (editor.renderer) {
      editor.controls.update();
      editor.renderer.render(editor.scene, editor.camera);
    }
  }
  animate();
}

function selectObject(obj) {
  if (editor.selectedObject === obj) return;
  deselectObject();
  editor.selectedObject = obj;
  if (obj.userData.editorType === 'box' || obj.userData.editorType === 'wall') {
    obj.material.emissive = new THREE.Color(0x333333);
  }
}

function deselectObject() {
  if (editor.selectedObject) {
    if (editor.selectedObject.userData.editorType === 'box' || editor.selectedObject.userData.editorType === 'wall') {
      editor.selectedObject.material.emissive = new THREE.Color(0x000000);
    }
    editor.selectedObject = null;
  }
}

function addObject(type) {
  let mesh;
  if (type === 'box') {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(2,2,2), new THREE.MeshStandardMaterial({ color: editor.currentColor }));
  } else if (type === 'wall') {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(1,4,10), new THREE.MeshStandardMaterial({ color: '#888888' }));
  }
  mesh.position.set(0, 1, 0);
  mesh.userData = { editorType: type, editorIndex: editor.objects.length };
  editor.scene.add(mesh);
  editor.objects.push({ type, mesh, data: getObjectData(mesh, type) });
  editor.dragControls.objects.push(mesh);
}

function getObjectData(mesh, type) {
  if (type === 'box') {
    return { type:'box', x:mesh.position.x, y:mesh.position.y, z:mesh.position.z,
             w:mesh.geometry.parameters.width, h:mesh.geometry.parameters.height, d:mesh.geometry.parameters.depth,
             color: '#' + mesh.material.color.getHexString() };
  } else if (type === 'wall') {
    return { type:'wall', x:mesh.position.x, y:mesh.position.y, z:mesh.position.z,
             w:mesh.geometry.parameters.width, h:mesh.geometry.parameters.height, d:mesh.geometry.parameters.depth,
             color: '#' + mesh.material.color.getHexString() };
  }
}

function updateEditorData(obj) {
  const idx = obj.userData.editorIndex;
  if (obj.userData.editorType === 'box' || obj.userData.editorType === 'wall') {
    editor.objects[idx].data = getObjectData(obj, obj.userData.editorType);
  }
}

function addSpawn(team) {
  const color = team === 't' ? 0xff0000 : 0x0000ff;
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.5,16,16), new THREE.MeshStandardMaterial({ color }));
  marker.position.set(0, 1, 0);
  marker.userData = { editorType: 'spawn', team };
  editor.scene.add(marker);
  editor.spawns.push({ team, mesh: marker, data: { team, x:0, y:1, z:0 } });
  editor.dragControls.objects.push(marker);
}

function addBombSite() {
  if (editor.bombSite) {
    editor.scene.remove(editor.bombSite.mesh);
    const idx = editor.dragControls.objects.indexOf(editor.bombSite.mesh);
    if (idx > -1) editor.dragControls.objects.splice(idx, 1);
  }
  const marker = new THREE.Mesh(new THREE.BoxGeometry(1,0.2,1), new THREE.MeshStandardMaterial({ color: 0xffff00 }));
  marker.position.set(0, 0, 0);
  marker.userData = { editorType: 'bomb' };
  editor.scene.add(marker);
  editor.bombSite = { mesh: marker, data: { x:0, y:0, z:0 } };
  editor.dragControls.objects.push(marker);
}

function setColor(color, el) {
  editor.currentColor = color;
  document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  if (editor.selectedObject && (editor.selectedObject.userData.editorType === 'box' || editor.selectedObject.userData.editorType === 'wall')) {
    editor.selectedObject.material.color.set(color);
    updateEditorData(editor.selectedObject);
  }
}

function scaleSelected(value) {
  if (!editor.selectedObject) return;
  const obj = editor.selectedObject;
  if (obj.userData.editorType === 'box' || obj.userData.editorType === 'wall') {
    obj.scale.set(parseFloat(value), parseFloat(value), parseFloat(value));
    updateEditorData(obj);
  }
}

function deleteSelected() {
  if (!editor.selectedObject) return;
  const obj = editor.selectedObject;
  const idx = editor.dragControls.objects.indexOf(obj);
  if (idx > -1) editor.dragControls.objects.splice(idx, 1);
  editor.scene.remove(obj);
  if (obj.userData.editorType === 'box' || obj.userData.editorType === 'wall') {
    editor.objects.splice(obj.userData.editorIndex, 1);
    editor.objects.forEach((o, i) => { o.mesh.userData.editorIndex = i; });
  }
  deselectObject();
}

function editorSaveMap() {
  const name = prompt('Название карты:');
  if (!name) return;
  const data = {
    spawns: editor.spawns.map(s => ({ team: s.team, x: s.mesh.position.x, y: s.mesh.position.y, z: s.mesh.position.z })),
    bombSite: editor.bombSite ? { x: editor.bombSite.mesh.position.x, y: editor.bombSite.mesh.position.y, z: editor.bombSite.mesh.position.z } : null,
    objects: editor.objects.map(o => getObjectData(o.mesh, o.type))
  };
  fetch('/api/maps', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
    body: JSON.stringify({ name, data })
  }).then(r=>r.json()).then(() => alert('Сохранено!'));
}

function editorLoadMap() {
  fetch('/api/maps', { headers:{'Authorization':'Bearer '+token} }).then(r=>r.json()).then(maps => {
    const id = prompt('ID карты:\n' + maps.map(m => `${m._id}: ${m.name}`).join('\n'));
    if (!id) return;
    fetch('/api/maps/'+id, { headers:{'Authorization':'Bearer '+token} }).then(r=>r.json()).then(m => {
      while(editor.scene.children.length > 3) editor.scene.remove(editor.scene.children[3]);
      editor.objects = []; editor.spawns = []; editor.bombSite = null;
      editor.dragControls.objects = [];

      m.data.objects?.forEach(o => {
        const geometry = o.type === 'box' ? new THREE.BoxGeometry(o.w, o.h, o.d) : new THREE.BoxGeometry(o.w, o.h, o.d);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: o.color || '#8B7355' }));
        mesh.position.set(o.x, o.y, o.z);
        mesh.userData = { editorType: o.type, editorIndex: editor.objects.length };
        editor.scene.add(mesh);
        editor.objects.push({ type: o.type, mesh, data: o });
        editor.dragControls.objects.push(mesh);
      });

      m.data.spawns?.forEach(s => {
        const color = s.team === 't' ? 0xff0000 : 0x0000ff;
        const marker = new THREE.Mesh(new THREE.SphereGeometry(0.5,16,16), new THREE.MeshStandardMaterial({color}));
        marker.position.set(s.x, s.y, s.z);
        marker.userData = { editorType:'spawn', team: s.team };
        editor.scene.add(marker);
        editor.spawns.push({ team: s.team, mesh: marker, data: s });
        editor.dragControls.objects.push(marker);
      });

      if (m.data.bombSite) {
        const marker = new THREE.Mesh(new THREE.BoxGeometry(1,0.2,1), new THREE.MeshStandardMaterial({color:0xffff00}));
        marker.position.set(m.data.bombSite.x, m.data.bombSite.y, m.data.bombSite.z);
        marker.userData = { editorType:'bomb' };
        editor.scene.add(marker);
        editor.bombSite = { mesh: marker, data: m.data.bombSite };
        editor.dragControls.objects.push(marker);
      }
    });
  });
}

function openEditor() {
  showScreen('editor');
  if (!editor.renderer) initEditor();
}

function closeEditor() {
  showMenu();
}
