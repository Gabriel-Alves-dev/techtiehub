// Tarefas da equipe.
//
// Ficam no nível do hub (data/tasks.json), como o chat da comunidade, porque uma tarefa pode ser
// compartilhada entre pessoas de escritórios diferentes. Quem enxerga uma tarefa: quem criou e
// quem foi adicionado em `people`. Delegar a um agente é sempre na mesa do próprio escritório.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['baixa', 'normal', 'alta'];

class Tasks {
  constructor(dir, auth, push) {
    this.auth = auth;
    this.push = push; // (userIds, event, data) — aviso em tempo real
    this.file = path.join(dir, 'tasks.json');
    try {
      this.list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.list = [];
    }
  }

  save(task) {
    fs.writeFileSync(this.file, JSON.stringify(this.list));
    if (task) this.push(this.members(task), 'tasks', {});
  }

  members(task) {
    return [...new Set([task.by, ...task.people])];
  }

  visible(user) {
    return this.list.filter((t) => t.by === user.id || t.people.includes(user.id));
  }

  // devolve a tarefa se a pessoa tem acesso; senão, erro
  get(user, id) {
    const t = this.list.find((x) => x.id === id);
    if (!t || !(t.by === user.id || t.people.includes(user.id))) throw new Error('tarefa não encontrada');
    return t;
  }

  // só colegas de equipe entram numa tarefa
  checkPeople(user, ids) {
    const team = new Set(this.auth.teamMembers(user).map((u) => u.id));
    return [...new Set([].concat(ids || []))].filter((id) => id !== user.id && team.has(id));
  }

  apply(user, task, body) {
    if (body.title !== undefined) {
      const title = String(body.title).trim().slice(0, 200);
      if (!title) throw new Error('dê um título à tarefa');
      task.title = title;
    }
    if (body.description !== undefined) task.description = String(body.description).slice(0, 8000);
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw new Error('status inválido');
      task.status = body.status;
      task.doneAt = body.status === 'done' ? Date.now() : null;
    }
    if (body.priority !== undefined) {
      if (!PRIORITIES.includes(body.priority)) throw new Error('prioridade inválida');
      task.priority = body.priority;
    }
    if (body.due !== undefined) task.due = /^\d{4}-\d{2}-\d{2}$/.test(body.due) ? body.due : null;
    if (body.bitrix !== undefined) task.bitrix = String(body.bitrix).trim().slice(0, 200);
    if (body.people !== undefined) task.people = this.checkPeople(user, body.people);
    task.updatedAt = Date.now();
  }

  create(user, body) {
    const task = {
      id: 't' + crypto.randomBytes(6).toString('base64url'), by: user.id, byName: user.name, title: '', description: '',
      status: 'todo', priority: 'normal', due: null, bitrix: '', people: [], delegations: [], createdAt: Date.now(),
    };
    this.apply(user, task, body);
    this.list.push(task);
    this.save(task);
    return task;
  }

  update(user, id, body) {
    const task = this.get(user, id);
    const before = this.members(task);
    // só quem criou muda quem participa e apaga; os participantes mexem no andamento
    if (body.people !== undefined && task.by !== user.id) throw new Error('só quem criou a tarefa muda os participantes');
    this.apply(user, task, body);
    this.save();
    this.push([...new Set([...before, ...this.members(task)])], 'tasks', {});
    return task;
  }

  remove(user, id) {
    const task = this.get(user, id);
    if (task.by !== user.id) throw new Error('só quem criou a tarefa pode apagá-la');
    this.list = this.list.filter((t) => t !== task);
    this.save(task);
  }

  // anota que a tarefa foi passada a um agente (quem, onde, quando)
  noteDelegation(user, task, desk) {
    task.delegations.push({ by: user.id, byName: user.name, desk, at: Date.now() });
    if (task.status === 'todo') task.status = 'doing';
    task.updatedAt = Date.now();
    this.save(task);
  }
}

// texto que vai para o agente quando a tarefa é delegada
function briefOf(task) {
  return [
    `Tarefa: ${task.title}`,
    task.description && `Detalhes:\n${task.description}`,
    `Prioridade: ${task.priority}${task.due ? ` · prazo ${task.due}` : ''}`,
    task.bitrix && `Bitrix: ${task.bitrix}`,
    `Criada por ${task.byName}.`,
  ].filter(Boolean).join('\n');
}

module.exports = { Tasks, briefOf, STATUSES, PRIORITIES };
